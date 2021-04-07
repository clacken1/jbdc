odoo.define('native_project_gantt.NativeProjectGanttRenderer', function (require) {
	"use strict";

	var AbstractRenderer = require('web.AbstractRenderer');
	var config = require('web.config');
	var core = require('web.core');
	var GanttRow = require('native_project_gantt.NativeProjectGanttRow');
	var qweb = require('web.QWeb');
	var session = require('web.session');
	var utils = require('web.utils');

	var QWeb = core.qweb;

	var NativeProjectGanttRenderer = AbstractRenderer.extend({
		config: {
			GanttRow: GanttRow
		},
		custom_events: _.extend({}, AbstractRenderer.prototype.custom_events, {
			'start_dragging': '_onStartDragging',
			'start_no_dragging': '_onStartNoDragging',
			'stop_dragging': '_onStopDragging',
			'stop_no_dragging': '_onStopNoDragging',
		}),

		DECORATIONS: [
			'decoration-secondary',
			'decoration-success',
			'decoration-info',
			'decoration-warning',
			'decoration-danger',
		],
		sampleDataTargets: [
			'.o_gantt_row',
		],
		init: function (parent, state, params) {
			var self = this;
			this._super.apply(this, arguments);

			this.$draggedPill = null;
			this.$draggedPillClone = null;

			this.canCreate = params.canCreate;
			this.canCellCreate = params.canCellCreate;
			this.canEdit = params.canEdit;
			this.canPlan = params.canPlan;
			this.cellPrecisions = params.cellPrecisions;
			this.colorField = params.colorField;
			this.progressField = params.progressField;
			this.consolidationParams = params.consolidationParams;
			this.fieldsInfo = params.fieldsInfo;
			this.SCALES = params.SCALES;
			this.string = params.string;
			this.totalRow = params.totalRow;
			this.collapseFirstLevel = params.collapseFirstLevel;
			this.thumbnails = params.thumbnails;
			this.rowWidgets = {};
			this.pillDecorations = _.chain(this.arch.attrs)
				.pick(function (value, key) {
					return self.DECORATIONS.indexOf(key) >= 0;
				}).mapObject(function (value) {
					return py.parse(py.tokenize(value));
				}).value();
			if (params.popoverTemplate) {
				this.popoverQWeb = new qweb(config.isDebug(), { _s: session.origin });
				this.popoverQWeb.add_template(utils.json_node_to_xml(params.popoverTemplate));
			} else {
				this.popoverQWeb = QWeb;
			}
		},
		on_attach_callback: function () {
			this._isInDom = true;
			core.bus.on("keydown", this, this._onKeydown);
			core.bus.on("keyup", this, this._onKeyup);
			this._setRowsDroppable();
		},
		on_detach_callback: function () {
			this._isInDom = false;
			core.bus.off("keydown", this, this._onKeydown);
			core.bus.off("keyup", this, this._onKeyup);
			_.invoke(this.rowWidgets, 'on_detach_callback');
		},
		updateRow: function (rowState) {
			var self = this;
			var oldRowIds = [rowState.id].concat(rowState.childrenRowIds);
			var oldRows = [];
			oldRowIds.forEach(function (rowId) {
				if (self.rowWidgets[rowId]) {
					oldRows.push(self.rowWidgets[rowId]);
					delete self.rowWidgets[rowId];
				}
			});
			this.proms = [];
			var rows = this._renderRows([rowState], rowState.groupedBy);
			var proms = this.proms;
			delete this.proms;
			return Promise.all(proms).then(function () {
				var $previousRow = oldRows[0].$el;
				rows.forEach(function (row) {
					row.$el.insertAfter($previousRow);
					$previousRow = row.$el;
				});
				_.invoke(oldRows, 'destroy');
			});
		},
		_getAction: function (event) {
			return event.ctrlKey || event.metaKey ? 'copy' : 'reschedule';
		},
		_getFocusDateFormat: function () {
			var focusDate = this.state.focusDate;
			switch (this.state.scale) {
				case 'day':
					return focusDate.format('dddd, MMMM DD, YYYY');
				case 'week':
					var dateStart = focusDate.clone().startOf('week').format('DD MMMM YYYY');
					var dateEnd = focusDate.clone().endOf('week').format('DD MMMM YYYY');
					return _.str.sprintf('%s - %s', dateStart, dateEnd);
				case 'month':
					return focusDate.format('MMMM YYYY');
				case 'year':
					return focusDate.format('YYYY');
				default:
					break;
			}
		},
		_getSlotsDates: function () {
			var token = this.SCALES[this.state.scale].interval;
			var stopDate = this.state.stopDate;
			var day = this.state.startDate;
			var dates = [];
			while (day <= stopDate) {
				dates.push(day);
				day = day.clone().add(1, token);
			}
			return dates;
		},
		_prepareViewInfo: function () {
			return {
				colorField: this.colorField,
				progressField: this.progressField,
				consolidationParams: this.consolidationParams,
				state: this.state,
				fieldsInfo: this.fieldsInfo,
				slots: this._getSlotsDates(),
				pillDecorations: this.pillDecorations,
				popoverQWeb: this.popoverQWeb,
				activeScaleInfo: {
					precision: this.cellPrecisions[this.state.scale],
					interval: this.SCALES[this.state.scale].cellPrecisions[this.cellPrecisions[this.state.scale]],
					time: this.SCALES[this.state.scale].time,
				},
			};
		},
		async _renderView() {
			var self = this;
			var oldRowWidgets = Object.keys(this.rowWidgets).map(function (rowId) {
				return self.rowWidgets[rowId];
			});
			this.rowWidgets = {};
			this.viewInfo = this._prepareViewInfo();

			this.proms = [];
			var rows = this._renderRows(this.state.rows, this.state.groupedBy);
			var totalRow;
			if (this.totalRow) {
				totalRow = this._renderTotalRow();
			}
			this.proms.push(this._super.apply(this, arguments));
			var proms = this.proms;
			delete this.proms;
			return Promise.all(proms).then(function () {
				self.$el.empty();
				_.invoke(oldRowWidgets, 'destroy');

				self._replaceElement(QWeb.render('native_project_gantt_GanttView', { widget: self }));
				const $containment = $('<div id="o_gantt_containment"/>');
				self.$('.o_gantt_row_container').append($containment);
				if (!self.state.groupedBy.length) {
					$containment.css({ left: 0 });
				}

				rows.forEach(function (row) {
					row.$el.appendTo(self.$('.o_gantt_row_container'));
				});
				if (totalRow) {
					totalRow.$el.appendTo(self.$('.o_gantt_total_row_container'));
				}

				if (self._isInDom) {
					self._setRowsDroppable();
				}

				if (self.state.isSample) {
					self._renderNoContentHelper();
				}
			});
		},
		_renderRows: function (rows, groupedBy) {
			var self = this;
			var rowWidgets = [];
			var disableResize = this.state.scale === 'year';

			var groupLevel = this.state.groupedBy.length - groupedBy.length;
			var hideSidebar = groupedBy.length === 0;
			if (this.collapseFirstLevel) {
				hideSidebar = self.state.groupedBy.length === 0;
			}
			rows.forEach(function (row) {
				var pillsInfo = {
					groupId: row.groupId,
					resId: row.resId,
					pills: row.records,
					groupLevel: groupLevel,
				};
				if (groupedBy.length) {
					pillsInfo.groupName = row.name;
					pillsInfo.groupedByField = row.groupedByField;
				}
				var params = {
					canCreate: self.canCreate,
					canCellCreate: self.canCellCreate,
					canEdit: self.canEdit,
					canPlan: self.canPlan,
					isGroup: row.isGroup,
					consolidate: (groupLevel === 0) && (self.state.groupedBy[0] === self.consolidationParams.maxField),
					hideSidebar: hideSidebar,
					isOpen: row.isOpen,
					disableResize: disableResize,
					rowId: row.id,
					scales: self.SCALES,
					unavailabilities: row.unavailabilities,
				};
				if (self.thumbnails && row.groupedByField && row.groupedByField in self.thumbnails) {
					params.thumbnail = { model: self.fieldsInfo[row.groupedByField].relation, field: self.thumbnails[row.groupedByField], };
				}
				rowWidgets.push(self._renderRow(pillsInfo, params));
				if (row.isGroup && row.isOpen) {
					var subRowWidgets = self._renderRows(row.rows, groupedBy.slice(1));
					rowWidgets = rowWidgets.concat(subRowWidgets);
				}
			});
			return rowWidgets;
		},
		_renderRow: function (pillsInfo, params) {
			var ganttRow = new this.config.GanttRow(this, pillsInfo, this.viewInfo, params);
			this.rowWidgets[ganttRow.rowId] = ganttRow;
			this.proms.push(ganttRow._widgetRenderAndInsert(function () { }));
			return ganttRow;
		},
		_renderTotalRow: function () {
			var pillsInfo = {
				groupId: "groupTotal",
				pills: this.state.records,
				groupLevel: 0,
				groupName: "Total"
			};
			var params = {
				canCreate: this.canCreate,
				canCellCreate: this.canCellCreate,
				canEdit: this.canEdit,
				canPlan: this.canPlan,
				hideSidebar: this.state.groupedBy.length === 0,
				isGroup: true,
				rowId: '__total_row__',
				scales: this.SCALES,
			};
			return this._renderRow(pillsInfo, params);
		},
		_setRowsDroppable: function () {
			const firstCell = this.$('.o_gantt_header_scale .o_gantt_header_cell:first')[0];
			_.invoke(this.rowWidgets, 'setDroppable', firstCell);
		},
		_onKeydown: function (ev) {
			this.action = this._getAction(ev);
			if (this.$draggedPill && this.action === 'copy') {
				this.$el.addClass('o_copying');
				this.$el.removeClass('o_grabbing');
			}
		},
		_onKeyup: function (ev) {
			this.action = this._getAction(ev);
			if (this.$draggedPill && this.action === 'reschedule') {
				this.$el.addClass('o_grabbing');
				this.$el.removeClass('o_copying');
			}
		},
		_onStartDragging: function (event) {
			this.$draggedPill = event.data.$draggedPill;
			this.$draggedPill.addClass('o_dragged_pill');
			if (this.action === 'copy') {
				this.$el.addClass('o_copying');
			} else {
				this.$el.addClass('o_grabbing');
			}
		},
		_onStartNoDragging: function () {
			this.$el.addClass('o_no_dragging');
		},
		_onStopDragging: function () {
			this.$draggedPill.removeClass('o_dragged_pill');
			this.$draggedPill = null;
			this.$draggedPillClone = null;
			this.$el.removeClass('o_grabbing');
			this.$el.removeClass('o_copying');
		},
		_onStopNoDragging: function () {
			this.$el.removeClass('o_no_dragging');
		},
	});
	return NativeProjectGanttRenderer;
});