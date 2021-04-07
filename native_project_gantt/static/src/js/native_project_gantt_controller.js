odoo.define('native_project_gantt.NativeProjectGanttController', function (require) {
	"use strict";

	var AbstractController = require('web.AbstractController');
	var core = require('web.core');
	var dialogs = require('web.view_dialogs');
	var confirmDialog = require('web.Dialog').confirm;

	var QWeb = core.qweb;
	var _t = core._t;

	var NativeProjectGanttController = AbstractController.extend({
		events: _.extend({}, AbstractController.prototype.events, {
			'click .o_gantt_button_add': '_onAddClicked',
			'click .o_gantt_button_scale': '_onScaleClicked',
			'click .o_gantt_button_prev': '_onPrevPeriodClicked',
			'click .o_gantt_button_next': '_onNextPeriodClicked',
			'click .o_gantt_button_today': '_onTodayClicked',
			'click .o_gantt_button_expand_rows': '_onExpandClicked',
			'click .o_gantt_button_collapse_rows': '_onCollapseClicked',
		}),
		custom_events: _.extend({}, AbstractController.prototype.custom_events, {
			add_button_clicked: '_onCellAddClicked',
			plan_button_clicked: '_onCellPlanClicked',
			collapse_row: '_onCollapseRow',
			expand_row: '_onExpandRow',
			pill_clicked: '_onPillClicked',
			pill_resized: '_onPillResized',
			pill_dropped: '_onPillDropped',
			updating_pill_started: '_onPillUpdatingStarted',
			updating_pill_stopped: '_onPillUpdatingStopped',
		}),
		init: function (parent, model, renderer, params) {
			this._super.apply(this, arguments);
			this.model = model;
			this.context = params.context;
			this.dialogViews = params.dialogViews;
			this.SCALES = params.SCALES;
			this.allowedScales = params.allowedScales;
			this.collapseFirstLevel = params.collapseFirstLevel;
			this.createAction = params.createAction;
		},
		renderButtons: function ($node) {
			var state = this.model.get();			
			this.$buttons = $(QWeb.render('native_project_gantt.buttons', {
				groupedBy: state.groupedBy,
				widget: this,
				SCALES: this.SCALES,
				activateScale: state.scale,
				allowedScales: this.allowedScales,
				activeActions: this.activeActions,
			}));
			if ($node) {
				this.$buttons.appendTo($node);
			}
		},
		_copy: function (id, schedule) {
			return this._executeAsyncOperation(
				this.model.copy.bind(this.model),
				[id, schedule]
			);
		},
		_executeAsyncOperation: function (operation, args) {
			const self = this;
			var prom = new Promise(function (resolve, reject) {
				var asyncOp = operation(...args);
				asyncOp.then(resolve).guardedCatch(resolve);
				self.dp.add(asyncOp).guardedCatch(reject);
			});
			return prom.then(this.reload.bind(this, {}));
		},
		_getDialogContext: function (date, groupId) {
			var state = this.model.get();
			var context = {};
			context[state.dateStartField] = date.clone();
			context[state.dateStopField] = date.clone().endOf(this.SCALES[state.scale].interval);

			if (groupId) {
				_.each(state.groupedBy, function (fieldName) {
					var groupValue = _.find(state.groups, function (group) {
						return group.id === groupId;
					});
					var value = groupValue[fieldName];
					if (_.isArray(value)) {
						value = value[0];
					}
					context[fieldName] = value;
				});
			}

			for (var k in context) {
				var type = state.fields[k].type;
				if (context[k] && (type === 'datetime' || type === 'date')) {
					context[k] = this.model.convertToServerTime(context[k]);
				}
			}

			return context;
		},
		_openDialog: function (resID, context) {
			var title = resID ? _t("Open") : _t("Create");
			return new dialogs.FormViewDialog(this, {
				title: _.str.sprintf(title),
				res_model: this.modelName,
				view_id: this.dialogViews[0][0],
				res_id: resID,
				readonly: !this.is_action_enabled('edit'),
				deletable: this.is_action_enabled('delete') && resID,
				context: _.extend({}, this.context, context),
				on_saved: this.reload.bind(this, {}),
				on_remove: this._onDialogRemove.bind(this, resID),
			}).open();
		},
		_onDialogRemove: function (resID) {
			var controller = this;
			var confirm = new Promise(function (resolve) {
				confirmDialog(this, _t('Are you sure to delete this record?'), {
					confirm_callback: function () {
						resolve(true);
					},
					cancel_callback: function () {
						resolve(false);
					},
				});
			});
			return confirm.then(function (confirmed) {
				if ((!confirmed)) {
					return Promise.resolve();
				}
				return controller._rpc({
					model: controller.modelName,
					method: 'unlink',
					args: [[resID,],],
				}).then(function () {
					return controller.reload();
				})
			});
		},
		_openPlanDialog: function (context) {
			var self = this;
			var state = this.model.get();
			var domain = [
				'|',
				[state.dateStartField, '=', false],
				[state.dateStopField, '=', false],
			];
			new dialogs.SelectCreateDialog(this, {
				title: _t("Plan"),
				res_model: this.modelName,
				domain: this.model.domain.concat(domain),
				views: this.dialogViews,
				context: _.extend({}, this.context, context),
				on_selected: function (records) {
					var ids = _.pluck(records, 'id');
					if (ids.length) {
						self._reschedule(ids, context, true);
					}
				},
			}).open();
		},

		_onCreate: function (context) {
			if (this.createAction) {
				var fullContext = _.extend({}, this.context, context);
				this.do_action(this.createAction, {
					additional_context: fullContext,
					on_close: this.reload.bind(this, {})
				});
			} else {
				this._openDialog(undefined, context);
			}
		},
		_reschedule: function (ids, schedule, isUTC) {
			return this._executeAsyncOperation(
				this.model.reschedule.bind(this.model),
				[ids, schedule, isUTC]
			);
		},
		_update: function () {
			var self = this;
			return this._super.apply(this, arguments).then(function () {
				if (self.$buttons) {
					var nbGroups = self.model.get().groupedBy.length;
					var minNbGroups = self.collapseFirstLevel ? 0 : 1;
					var displayButtons = nbGroups > minNbGroups;
					self.$buttons.find('.o_gantt_button_expand_rows').toggle(displayButtons);
					self.$buttons.find('.o_gantt_button_collapse_rows').toggle(displayButtons);
				}
			});
		},
		_onCellAddClicked: function (ev) {
			ev.stopPropagation();
			var context = this._getDialogContext(ev.data.date, ev.data.groupId);
			for (var k in context) {
				context[_.str.sprintf('default_%s', k)] = context[k];
			}
			this._onCreate(context);
		},
		_onAddClicked: function (ev) {
			ev.preventDefault();
			var context = {};
			var state = this.model.get();
			context[state.dateStartField] = this.model.convertToServerTime(state.focusDate.clone().startOf(state.scale));
			context[state.dateStopField] = this.model.convertToServerTime(state.focusDate.clone().endOf(state.scale));
			for (var k in context) {
				context[_.str.sprintf('default_%s', k)] = context[k];
			}
			this._onCreate(context);
		},
		_onCollapseClicked: function (ev) {
			ev.preventDefault();
			this.model.collapseRows();
			this.update({}, { reload: false });
		},
		_onCollapseRow: function (ev) {
			ev.stopPropagation();
			this.model.collapseRow(ev.data.rowId);
			this.renderer.updateRow(this.model.get(ev.data.rowId));
		},
		_onExpandClicked: function (ev) {
			ev.preventDefault();
			this.model.expandRows();
			this.update({}, { reload: false });
		},
		_onExpandRow: function (ev) {
			ev.stopPropagation();
			this.model.expandRow(ev.data.rowId);
			this.renderer.updateRow(this.model.get(ev.data.rowId));
		},
		_onNextPeriodClicked: function (ev) {
			ev.preventDefault();
			var state = this.model.get();
			this.update({ date: state.focusDate.add(1, state.scale) });
		},
		_onPillClicked: async function (ev) {
			if (!this._updating) {
				ev.data.target.addClass('o_gantt_pill_editing');
				await this.model.mutex.getUnlockedDef();

				var dialog = this._openDialog(ev.data.target.data('id'));
				dialog.on('closed', this, function () {
					ev.data.target.removeClass('o_gantt_pill_editing');
				});
			}
		},
		_onPillDropped: function (ev) {
			ev.stopPropagation();

			var state = this.model.get();

			var schedule = {};

			var diff = ev.data.diff;
			if (diff) {
				var pill = _.findWhere(state.records, { id: ev.data.pillId });
				schedule[state.dateStartField] = pill[state.dateStartField].clone().add(diff, this.SCALES[state.scale].time);
				schedule[state.dateStopField] = pill[state.dateStopField].clone().add(diff, this.SCALES[state.scale].time);
			} else if (ev.data.action === 'copy') {
				const pill = _.findWhere(state.records, { id: ev.data.pillId });
				schedule[state.dateStartField] = pill[state.dateStartField].clone();
				schedule[state.dateStopField] = pill[state.dateStopField].clone();
			}

			if (ev.data.newGroupId && ev.data.newGroupId !== ev.data.oldGroupId) {
				var group = _.findWhere(state.groups, { id: ev.data.newGroupId });

				var fieldsToWrite = state.groupedBy.slice(0, ev.data.groupLevel + 1);
				_.each(fieldsToWrite, function (fieldName) {
					schedule[fieldName] = group[fieldName];

					if (_.isArray(schedule[fieldName])) {
						schedule[fieldName] = schedule[fieldName][0];
					}
				});
			}
			if (ev.data.action === 'copy') {
				this._copy(ev.data.pillId, schedule);
			} else {
				this._reschedule(ev.data.pillId, schedule);
			}
		},
		_onPillResized: function (ev) {
			ev.stopPropagation();
			var schedule = {};
			schedule[ev.data.field] = ev.data.date;
			this._reschedule(ev.data.id, schedule);
		},
		_onPillUpdatingStarted: function (ev) {
			ev.stopPropagation();
			this._updating = true;
		},
		_onPillUpdatingStopped: function (ev) {
			ev.stopPropagation();
			this._updating = false;
		},
		_onCellPlanClicked: function (ev) {
			ev.stopPropagation();
			var context = this._getDialogContext(ev.data.date, ev.data.groupId);
			this._openPlanDialog(context);
		},
		_onPrevPeriodClicked: function (ev) {
			ev.preventDefault();
			var state = this.model.get();
			this.update({ date: state.focusDate.subtract(1, state.scale) });
		},
		_onScaleClicked: function (ev) {
			ev.preventDefault();
			var $button = $(ev.currentTarget);
			this.$buttons.find('.o_gantt_button_scale').removeClass('active');
			$button.addClass('active');
			this.$buttons.find('.o_gantt_dropdown_selected_scale').text($button.text());
			this.update({ scale: $button.data('value') });
		},
		_onTodayClicked: function (ev) {
			ev.preventDefault();
			this.update({ date: moment() });
		},
	});
	return NativeProjectGanttController;
});