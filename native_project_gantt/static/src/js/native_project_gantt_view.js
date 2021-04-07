odoo.define('native_project_gantt.NativeProjectGanttView', function (require) {
	"use strict";

	var AbstractView = require('web.AbstractView');
	var core = require('web.core');
	var NativeProjectGanttModel = require('native_project_gantt.NativeProjectGanttModel');
	var NativeProjectGanttRenderer = require('native_project_gantt.NativeProjectGanttRenderer');
	var NativeProjectGanttController = require('native_project_gantt.NativeProjectGanttController');
	var pyUtils = require('web.py_utils');
	var view_registry = require('web.view_registry');

	var _t = core._t;
	var _lt = core._lt;

	var NativeProjectGanttView = AbstractView.extend({
		display_name: _lt('Gantt'),
		icon: 'fa-tasks',
		config: _.extend({}, AbstractView.prototype.config, {
			Model: NativeProjectGanttModel,
			Controller: NativeProjectGanttController,
			Renderer: NativeProjectGanttRenderer,
		}),
		jsLibs: [
			'/web/static/lib/nearest/jquery.nearest.js',
		],
		viewType: 'gantt',
		init: function (viewInfo, params) {
			this._super.apply(this, arguments);
			this.SCALES = {
				day: { string: _t('Day'), cellPrecisions: { full: 60, half: 30, quarter: 15 }, defaultPrecision: 'full', time: 'minutes', interval: 'hour' },
				week: { string: _t('Week'), cellPrecisions: { full: 24, half: 12 }, defaultPrecision: 'half', time: 'hours', interval: 'day' },
				month: { string: _t('Month'), cellPrecisions: { full: 24, half: 12 }, defaultPrecision: 'half', time: 'hours', interval: 'day' },
				year: { string: _t('Year'), cellPrecisions: { full: 1 }, defaultPrecision: 'full', time: 'months', interval: 'month' },
			};
			var arch = this.arch;
			var decorationFields = [];
			_.each(arch.children, function (child) {
				if (child.tag === 'field') {
					decorationFields.push(child.attrs.name);
				}
			});
			var collapseFirstLevel = !!arch.attrs.collapse_first_level;
			var displayUnavailability = !!arch.attrs.display_unavailability;
			var colorField = arch.attrs.color;
			var precisionAttrs = arch.attrs.precision ? pyUtils.py_eval(arch.attrs.precision) : {};
			var cellPrecisions = {};
			_.each(this.SCALES, function (vals, key) {
				if (precisionAttrs[key]) {
					var precision = precisionAttrs[key].split(':');
					if (precision[1] && _.contains(_.keys(vals.cellPrecisions), precision[1])) {
						cellPrecisions[key] = precision[1];
					}
				}
				cellPrecisions[key] = cellPrecisions[key] || vals.defaultPrecision;
			});
			var consolidationMaxField;
			var consolidationMaxValue;
			var consolidationMax = arch.attrs.consolidation_max ? pyUtils.py_eval(arch.attrs.consolidation_max) : {};
			if (Object.keys(consolidationMax).length > 0) {
				consolidationMaxField = Object.keys(consolidationMax)[0];
				consolidationMaxValue = consolidationMax[consolidationMaxField];
				collapseFirstLevel = !!consolidationMaxField || collapseFirstLevel;
			}
			var consolidationParams = {
				field: arch.attrs.consolidation,
				maxField: consolidationMaxField,
				maxValue: consolidationMaxValue,
				excludeField: arch.attrs.consolidation_exclude,
			};
			var formViewId = arch.attrs.form_view_id ? parseInt(arch.attrs.form_view_id, 10) : false;
			if (params.action && !formViewId) {
				var result = _.findWhere(params.action.views, {
					type: 'form'
				});
				formViewId = result ? result.viewID : false;
			}
			var dialogViews = [
				[formViewId, 'form']
			];
			var allowedScales;
			if (arch.attrs.scales) {
				var possibleScales = Object.keys(this.SCALES);
				allowedScales = _.reduce(arch.attrs.scales.split(','), function (allowedScales, scale) {
					if (possibleScales.indexOf(scale) >= 0) {
						allowedScales.push(scale.trim());
					}
					return allowedScales;
				}, []);
			} else {
				allowedScales = Object.keys(this.SCALES);
			}
			var scale = params.context.default_scale || arch.attrs.default_scale || 'week';
			var initialDate = moment(params.context.initialDate || params.initialDate || arch.attrs.initial_date || new Date());
			var offset = arch.attrs.offset;
			if (offset && scale) {
				initialDate.add(offset, scale);
			}

			var thumbnails = this.arch.attrs.thumbnails ? pyUtils.py_eval(this.arch.attrs.thumbnails) : {};
			var canPlan = this.arch.attrs.plan ? !!JSON.parse(this.arch.attrs.plan) : true;
			var canCellCreate = this.arch.attrs.cell_create ? !!JSON.parse(this.arch.attrs.cell_create) : true;

			this.controllerParams.context = params.context || {};
			this.controllerParams.dialogViews = dialogViews;
			this.controllerParams.SCALES = this.SCALES;
			this.controllerParams.allowedScales = allowedScales;
			this.controllerParams.collapseFirstLevel = collapseFirstLevel;
			this.controllerParams.createAction = arch.attrs.on_create || null;
			this.loadParams.initialDate = initialDate;
			this.loadParams.collapseFirstLevel = collapseFirstLevel;
			this.loadParams.colorField = colorField;
			this.loadParams.dateStartField = arch.attrs.date_start;
			this.loadParams.dateStopField = arch.attrs.date_stop;
			this.loadParams.progressField = arch.attrs.progress;
			this.loadParams.decorationFields = decorationFields;
			this.loadParams.defaultGroupBy = this.arch.attrs.default_group_by;
			this.loadParams.displayUnavailability = displayUnavailability;
			this.loadParams.fields = this.fields;
			this.loadParams.scale = scale;
			this.loadParams.consolidationParams = consolidationParams;
			
			this.rendererParams.canCellCreate = canCellCreate;
			this.rendererParams.canCreate = this.controllerParams.activeActions.create;
			this.rendererParams.canEdit = this.controllerParams.activeActions.edit;
			this.rendererParams.canPlan = canPlan && this.rendererParams.canEdit;
			this.rendererParams.fieldsInfo = viewInfo.fields;
			this.rendererParams.SCALES = this.SCALES;
			this.rendererParams.cellPrecisions = cellPrecisions;
			this.rendererParams.totalRow = arch.attrs.total_row || false;
			this.rendererParams.string = arch.attrs.string || _t('Project Gantt View');
			this.rendererParams.popoverTemplate = _.findWhere(arch.children, {
				tag: 'templates'
			});
			this.rendererParams.colorField = colorField;
			this.rendererParams.progressField = arch.attrs.progress;
			this.rendererParams.displayUnavailability = displayUnavailability;
			this.rendererParams.collapseFirstLevel = collapseFirstLevel;
			this.rendererParams.consolidationParams = consolidationParams;
			this.rendererParams.thumbnails = thumbnails;
		},
	});
	view_registry.add('ganttview', NativeProjectGanttView);
	return NativeProjectGanttView;
});