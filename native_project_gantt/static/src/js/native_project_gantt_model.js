odoo.define('native_project_gantt.NativeProjectGanttModel', function (require) {
	"use strict";

	var AbstractModel = require('web.AbstractModel');
	var concurrency = require('web.concurrency');
	var core = require('web.core');
	var fieldUtils = require('web.field_utils');
	var session = require('web.session');

	var _t = core._t;

	var NativeProjectGanttModel = AbstractModel.extend({
		init: function () {
			this._super.apply(this, arguments);

			this.dp = new concurrency.DropPrevious();
			this.mutex = new concurrency.Mutex();
		},
		collapseRow: function (rowId) {
			this.allRows[rowId].isOpen = false;
		},
		collapseRows: function () {
			this.ganttData.rows.forEach(function (group) {
				group.isOpen = false;
			});
		},
		convertToServerTime: function (date) {
			var result = date.clone();
			if (!result.isUTC()) {
				result.subtract(session.getTZOffset(date), 'minutes');
			}
			return result.locale('en').format('YYYY-MM-DD HH:mm:ss');
		},
		__get: function (rowId) {
			if (rowId) {
				return this.allRows[rowId];
			} else {
				return Object.assign({ isSample: this.isSampleModel }, this.ganttData);
			}
		},
		expandRow: function (rowId) {
			this.allRows[rowId].isOpen = true;
		},
		expandRows: function () {
			var self = this;
			Object.keys(this.allRows).forEach(function (rowId) {
				var row = self.allRows[rowId];
				if (row.isGroup) {
					self.allRows[rowId].isOpen = true;
				}
			});
		},
		__load: async function (params) {
			await this._super(...arguments);
			this.modelName = params.modelName;
			this.fields = params.fields;
			this.domain = params.domain;
			this.context = params.context;
			this.decorationFields = params.decorationFields;
			this.colorField = params.colorField;
			this.progressField = params.progressField;
			this.consolidationParams = params.consolidationParams;
			this.collapseFirstLevel = params.collapseFirstLevel;
			this.displayUnavailability = params.displayUnavailability;
			this.SCALES = params.SCALES;

			this.defaultGroupBy = params.defaultGroupBy ? [params.defaultGroupBy] : [];
			let groupedBy = params.groupedBy;
			if (!groupedBy || !groupedBy.length) {
				groupedBy = this.defaultGroupBy;
			}
			groupedBy = this._filterDateInGroupedBy(groupedBy);

			this.ganttData = {
				dateStartField: params.dateStartField,
				dateStopField: params.dateStopField,
				groupedBy,
				fields: params.fields,
				dynamicRange: params.dynamicRange,
			};
			this._setRange(params.initialDate, params.scale);
			return this._fetchData().then(function () {
				return Promise.resolve();
			});
		},
		__reload: async function (handle, params) {
			await this._super(...arguments);
			if ('scale' in params) {
				this._setRange(this.ganttData.focusDate, params.scale);
			}
			if ('date' in params) {
				this._setRange(params.date, this.ganttData.scale);
			}
			if ('domain' in params) {
				this.domain = params.domain;
			}
			if ('groupBy' in params) {
				if (params.groupBy && params.groupBy.length) {
					this.ganttData.groupedBy = this._filterDateInGroupedBy(params.groupBy);
					if (this.ganttData.groupedBy.length !== params.groupBy.length) {
						this.do_warn(false, _t('Grouping by date is not supported'));
					}
				} else {
					this.ganttData.groupedBy = this.defaultGroupBy;
				}
			}
			return this._fetchData()
		},
		copy: function (id, schedule) {
			var self = this;
			const defaults = this.rescheduleData(schedule);
			return this.mutex.exec(function () {
				return self._rpc({
					model: self.modelName,
					method: 'copy',
					args: [id, defaults],
					context: self.context,
				});
			});
		},
		reschedule: function (ids, schedule, isUTC) {
			var self = this;
			if (!_.isArray(ids)) {
				ids = [ids];
			}
			const data = this.rescheduleData(schedule, isUTC);
			return this.mutex.exec(function () {
				return self._rpc({
					model: self.modelName,
					method: 'write',
					args: [ids, data],
					context: self.context,
				});
			});
		},
		rescheduleData: function (schedule, isUTC) {
			const allowedFields = [
				this.ganttData.dateStartField,
				this.ganttData.dateStopField,
				...this.ganttData.groupedBy
			];

			const data = _.pick(schedule, allowedFields);

			let type;
			for (let k in data) {
				type = this.fields[k].type;
				if (data[k] && (type === 'datetime' || type === 'date') && !isUTC) {
					data[k] = this.convertToServerTime(data[k]);
				}
			};
			return data
		},
		_fetchData: function () {
			var self = this;
			var domain = this._getDomain();
			var context = Object.assign({}, this.context, { group_by: this.ganttData.groupedBy });

			var groupsDef;
			if (this.ganttData.groupedBy.length) {
				groupsDef = this._rpc({
					model: this.modelName,
					method: 'read_group',
					fields: this._getFields(),
					domain: domain,
					context: context,
					groupBy: this.ganttData.groupedBy,
					orderBy: this.ganttData.groupedBy.map(function (f) { return { name: f }; }),
					lazy: this.ganttData.groupedBy.length === 1,
				});
			}

			var dataDef = this._rpc({
				route: '/web/dataset/search_read',
				model: this.modelName,
				fields: this._getFields(),
				context: context,
				domain: domain,
			});

			return this.dp.add(Promise.all([groupsDef, dataDef])).then(function (results) {
				var groups = results[0];
				var searchReadResult = results[1];
				if (groups) {
					_.each(groups, function (group) {
						group.id = _.uniqueId('group');
					});
				}
				var oldRows = self.allRows;
				self.allRows = {};
				self.ganttData.groups = groups;
				self.ganttData.records = self._parseServerData(searchReadResult.records);
				self.ganttData.rows = self._generateRows({
					groupedBy: self.ganttData.groupedBy,
					groups: groups,
					oldRows: oldRows,
					records: self.ganttData.records,
				});
				var unavailabilityProm;
				if (self.displayUnavailability && !self.isSampleModel) {
					unavailabilityProm = self._fetchUnavailability();
				}
				return unavailabilityProm;
			});
		},
		_computeUnavailabilityRows: function (rows) {
			var self = this;
			return _.map(rows, function (r) {
				if (r) {
					return {
						groupedBy: r.groupedBy,
						records: r.records,
						name: r.name,
						resId: r.resId,
						rows: self._computeUnavailabilityRows(r.rows)
					}
				} else {
					return r;
				}
			});
		},
		_fetchUnavailability: function () {
			var self = this;
			return this._rpc({
				model: this.modelName,
				method: 'gantt_unavailability',
				args: [
					this.convertToServerTime(this.ganttData.startDate),
					this.convertToServerTime(this.ganttData.stopDate),
					this.ganttData.scale,
					this.ganttData.groupedBy,
					this._computeUnavailabilityRows(this.ganttData.rows),
				],
				context: this.context,
			}).then(function (enrichedRows) {
				self._updateUnavailabilityRows(self.ganttData.rows, enrichedRows);
			});
		},
		_updateUnavailabilityRows: function (original, enriched) {
			var self = this;
			_.zip(original, enriched).forEach(function (rowPair) {
				var o = rowPair[0];
				var e = rowPair[1];
				o.unavailabilities = _.map(e.unavailabilities, function (u) {
					u.start = self._parseServerValue({ type: 'datetime' }, u.start);
					u.stop = self._parseServerValue({ type: 'datetime' }, u.stop);
					return u;
				});
				if (o.rows && e.rows) {
					self._updateUnavailabilityRows(o.rows, e.rows);
				}
			});
		},
		_generateRows: function (params) {
			var self = this;
			var groups = params.groups;
			var groupedBy = params.groupedBy;
			var rows;
			if (!groupedBy.length) {
				var row = {
					groupId: groups && groups.length && groups[0].id,
					id: _.uniqueId('row'),
					records: params.records,
				};
				rows = [row];
				this.allRows[row.id] = row;
			} else {
				var groupedByField = groupedBy[0];
				var currentLevelGroups = _.groupBy(groups, groupedByField);
				rows = Object.keys(currentLevelGroups).map(function (key) {
					var subGroups = currentLevelGroups[key];
					var groupRecords = _.filter(params.records, function (record) {
						return _.isEqual(record[groupedByField], subGroups[0][groupedByField]);
					});
					var value;
					if (groupRecords.length) {
						value = groupRecords[0][groupedByField];
					} else {
						value = subGroups[0][groupedByField];
					}

					var path = (params.parentPath || '') + JSON.stringify(value);
					var minNbGroups = self.collapseFirstLevel ? 0 : 1;
					var isGroup = groupedBy.length > minNbGroups;
					var row = {
						name: self._getFieldFormattedValue(value, self.fields[groupedByField]),
						groupId: subGroups[0].id,
						groupedBy: groupedBy,
						groupedByField: groupedByField,
						id: _.uniqueId('row'),
						resId: _.isArray(value) ? value[0] : value,
						isGroup: isGroup,
						isOpen: !_.findWhere(params.oldRows, { path: path, isOpen: false }),
						path: path,
						records: groupRecords,
					};

					if (isGroup) {
						row.rows = self._generateRows({
							groupedBy: groupedBy.slice(1),
							groups: subGroups,
							oldRows: params.oldRows,
							parentPath: row.path + '/',
							records: groupRecords,
						});
						row.childrenRowIds = [];
						row.rows.forEach(function (subRow) {
							row.childrenRowIds.push(subRow.id);
							row.childrenRowIds = row.childrenRowIds.concat(subRow.childrenRowIds || []);
						});
					}

					self.allRows[row.id] = row;

					return row;
				});
				if (!rows.length) {
					rows = [{
						groups: [],
						records: [],
					}];
				}
			}
			return rows;
		},
		_getDomain: function () {
			var domain = [
				[this.ganttData.dateStartField, '<=', this.convertToServerTime(this.ganttData.stopDate)],
				[this.ganttData.dateStopField, '>=', this.convertToServerTime(this.ganttData.startDate)],
			];
			return this.domain.concat(domain);
		},
		_getFields: function () {
			var fields = ['display_name', this.ganttData.dateStartField, this.ganttData.dateStopField, 'progress'];
			fields = fields.concat(this.ganttData.groupedBy, this.decorationFields);

			if (this.progressField) {
				fields.push(this.progressField);
			}

			if (this.colorField) {
				fields.push(this.colorField);
			}

			if (this.consolidationParams.field) {
				fields.push(this.consolidationParams.field);
			}

			if (this.consolidationParams.excludeField) {
				fields.push(this.consolidationParams.excludeField);
			}

			return _.uniq(fields);
		},
		_getFieldFormattedValue: function (value, field) {
			var options = {};
			if (field.type === 'boolean') {
				options = { forceString: true };
			}
			var formattedValue = fieldUtils.format[field.type](value, field, options);
			return formattedValue || _.str.sprintf(_t('Undefined %s'), field.string);
		},
		_parseServerData: function (data) {
			var self = this;

			data.forEach(function (record) {
				Object.keys(record).forEach(function (fieldName) {
					record[fieldName] = self._parseServerValue(self.fields[fieldName], record[fieldName]);
				});
			});

			return data;
		},
		_setRange: function (focusDate, scale) {
			this.ganttData.scale = scale;
			this.ganttData.focusDate = focusDate;
			if (this.ganttData.dynamicRange) {
				this.ganttData.startDate = focusDate.clone().startOf(this.SCALES[scale].interval);
				this.ganttData.stopDate = this.ganttData.startDate.clone().add(1, scale);
			} else {
				this.ganttData.startDate = focusDate.clone().startOf(scale);
				this.ganttData.stopDate = focusDate.clone().endOf(scale);
			}
		},
		_filterDateInGroupedBy(groupedBy) {
			return groupedBy.filter(
				groupedByField => {
					var fieldName = groupedByField.split(':')[0];
					return fieldName in this.fields && this.fields[fieldName].type.indexOf('date') === -1;
				}
			);
		},
	});
	return NativeProjectGanttModel;
});