odoo.define('native_project_gantt.NativeProjectGanttRow', function (require) {
	"use strict";
	var core = require('web.core');
	var session = require('web.session');
	var Widget = require('web.Widget');
	const pyUtils = require('web.py_utils');

	var QWeb = core.qweb;
	var _t = core._t;
	var NativeProjectGanttRow = Widget.extend({
		template: 'native_project_gantt.Row',
		events: {
			'mouseleave': '_onMouseLeave',
			'mousemove .o_gantt_cell': '_onMouseMove',
			'mouseenter .o_gantt_pill': '_onPillEntered',
			'click .o_gantt_pill': '_onPillClicked',
			'click': '_onRowSidebarClicked',
			'click .o_gantt_cell_buttons > div > .o_gantt_cell_add': '_onButtonAddClicked',
			'click .o_gantt_cell_buttons > div > .o_gantt_cell_plan': '_onButtonPlanClicked',
		},
		NB_GANTT_RECORD_COLORS: 12,
		LEVEL_LEFT_OFFSET: 16,
		LEVEL_TOP_OFFSET: 31,
		POPOVER_DELAY: 260,
		init: function (parent, pillsInfo, viewInfo, options) {
			this._super.apply(this, arguments);
			var self = this;

			this.name = pillsInfo.groupName;
			this.groupId = pillsInfo.groupId;
			this.groupLevel = pillsInfo.groupLevel;
			this.groupedByField = pillsInfo.groupedByField;
			this.pills = _.map(pillsInfo.pills, _.clone);
			this.resId = pillsInfo.resId;

			this.viewInfo = viewInfo;
			this.fieldsInfo = viewInfo.fieldsInfo;
			this.state = viewInfo.state;
			this.colorField = viewInfo.colorField;

			this.options = options;
			this.SCALES = options.scales;
			this.isGroup = options.isGroup;
			this.isOpen = options.isOpen;
			this.rowId = options.rowId;
			this.unavailabilities = (options.unavailabilities || []).map(u => {
				return {
					startDate: self._convertToUserTime(u.start),
					stopDate: self._convertToUserTime(u.stop)
				};
			});

			this.consolidate = options.consolidate;
			this.consolidationParams = viewInfo.consolidationParams;

			if (options.thumbnail) {
				this.thumbnailUrl = session.url('/web/image', {
					model: options.thumbnail.model,
					id: this.resId,
					field: this.options.thumbnail.field,
				});
			}

			this.isTotal = this.groupId === 'groupTotal';

			this._adaptPills();
			this._snapToGrid(this.pills);
			this._calculateLevel();
			if (this.isGroup && this.pills.length) {
				this._aggregateGroupedPills();
			} else {
				this.progressField = viewInfo.progressField;
				this._evaluateDecoration();
			}
			this._calculateMarginAndWidth();

			this.leftPadding = (this.groupLevel + 1) * this.LEVEL_LEFT_OFFSET;
			this.cellHeight = this.level * this.LEVEL_TOP_OFFSET + (this.level > 0 ? this.level - 1 : 0);

			this.MIN_WIDTHS = { full: 100, half: 50, quarter: 25 };
			this.PARTS = { full: 1, half: 2, quarter: 4 };

			this.cellMinWidth = this.MIN_WIDTHS[this.viewInfo.activeScaleInfo.precision];
			this.cellPart = this.PARTS[this.viewInfo.activeScaleInfo.precision];

			this._prepareSlots();
			this._insertIntoSlot();

			this.childrenRows = [];

			this._onButtonAddClicked = _.debounce(this._onButtonAddClicked, 500, true);
			this._onButtonPlanClicked = _.debounce(this._onButtonPlanClicked, 500, true);
			this._onPillClicked = _.debounce(this._onPillClicked, 500, true);

			if (this.isTotal) {
				const maxCount = Math.max(...this.pills.map(p => p.count));
				const factor = maxCount ? (90 / maxCount) : 0;
				for (let p of this.pills) {
					p.totalHeight = factor * p.count;
				}
			}
			this.isRTL = _t.database.parameters.direction === "rtl";
		},
		setDroppable: function (firstCell) {
			if (this.isTotal) {
				return;
			}
			var self = this;
			const resizeSnappingWidth = this._getResizeSnappingWidth(firstCell);
			this.$el.droppable({
				drop: function (event, ui) {
					var diff = self._getDiff(resizeSnappingWidth, ui.position.left);
					var $pill = ui.draggable;
					var oldGroupId = $pill.closest('.o_gantt_row').data('group-id');
					if (diff || (self.groupId !== oldGroupId)) { // do not perform write if nothing change
						const action = event.ctrlKey || event.metaKey ? 'copy' : 'reschedule';
						self._saveDragChanges($pill.data('id'), diff, oldGroupId, self.groupId, action);
					} else {
						ui.helper.animate({
							left: 0,
							top: 0,
						});
					}
				},
				tolerance: 'intersect',
			});
		},
		_bindPopover: function () {
			var self = this;
			this.$('.o_gantt_pill').popover({
				container: this.$el,
				trigger: 'hover',
				delay: { show: this.POPOVER_DELAY},
				html: true,
				placement: 'top',
				content: function () {
					return self.viewInfo.popoverQWeb.render('native_project_gantt.gantt-popover', self._getPopoverContext($(this).data('id')));
				},
			});
		},
		_bindPillPopover: function (target) {
			var self = this;
			var $target = $(target);
			if (!$target.hasClass('o_gantt_pill')) {
				$target = this.$(target.offsetParent);
			}
			$target.popover({
				container: this.$el,
				trigger: 'hover',
				delay: { show: this.POPOVER_DELAY},
				html: true,
				placement: 'top',
				content: function () {
					return self.viewInfo.popoverQWeb.render('native_project_gantt.gantt-popover', self._getPopoverContext($(this).data('id')));
				},
			}).popover("show");
		},
		_calculateLevel: function () {
			if (this.isGroup || !this.pills.length) {
				this.level = 0;
				this.pills.forEach(function (pill) {
					pill.level = 0;
				});
			} else {
				this.pills = _.sortBy(this.pills, 'startDate');
				this.pills[0].level = 0;
				var levels = [{
					pills: [this.pills[0]],
					maxStopDate: this.pills[0].stopDate,
				}];
				for (var i = 1; i < this.pills.length; i++) {
					var currentPill = this.pills[i];
					for (var l = 0; l < levels.length; l++) {
						if (currentPill.startDate >= levels[l].maxStopDate) {
							currentPill.level = l;
							levels[l].pills.push(currentPill);
							if (currentPill.stopDate > levels[l].maxStopDate) {
								levels[l].maxStopDate = currentPill.stopDate;
							}
							break;
						}
					}
					if (!currentPill.level && currentPill.level != 0) {
						currentPill.level = levels.length;
						levels.push({
							pills: [currentPill],
							maxStopDate: currentPill.stopDate,
						});
					}
				}
				this.level = levels.length;
			}
		},
		_adaptPills: function () {
			var self = this;
			var dateStartField = this.state.dateStartField;
			var dateStopField = this.state.dateStopField;
			var ganttStartDate = this.state.startDate;
			var ganttStopDate = this.state.stopDate;
			this.pills.forEach(function (pill) {
				var pillStartDate = self._convertToUserTime(pill[dateStartField]);
				var pillStopDate = self._convertToUserTime(pill[dateStopField]);
				if (pillStartDate < ganttStartDate) {
					pill.startDate = ganttStartDate;
					pill.disableStartResize = true;
				} else {
					pill.startDate = pillStartDate;
				}
				if (pillStopDate > ganttStopDate) {
					pill.stopDate = ganttStopDate;
					pill.disableStopResize = true;
				} else {
					pill.stopDate = pillStopDate;
				}
				if (self.isGroup) {
					pill.disableStartResize = true;
					pill.disableStopResize = true;
				}
			});
		},
		_aggregateGroupedPills: function () {
			var self = this;
			var sortedPills = _.sortBy(_.map(this.pills, _.clone), 'startDate');
			var firstPill = sortedPills[0];
			firstPill.count = 1;

			var timeToken = this.SCALES[this.state.scale].time;
			var precision = this.viewInfo.activeScaleInfo.precision;
			var cellTime = this.SCALES[this.state.scale].cellPrecisions[precision];
			var intervals = _.reduce(this.viewInfo.slots, function (intervals, slotStart) {
				intervals.push(slotStart);
				if (precision === 'half') {
					intervals.push(slotStart.clone().add(cellTime, timeToken));
				}
				return intervals;
			}, []);

			this.pills = _.reduce(intervals, function (pills, intervalStart) {
				var intervalStop = intervalStart.clone().add(cellTime, timeToken);
				var pillsInThisInterval = _.filter(self.pills, function (pill) {
					return pill.startDate < intervalStop && pill.stopDate > intervalStart;
				});
				if (pillsInThisInterval.length) {
					var previousPill = pills[pills.length - 1];
					var isContinuous = previousPill &&
						_.intersection(previousPill.aggregatedPills, pillsInThisInterval).length;

					if (isContinuous && previousPill.count === pillsInThisInterval.length) {
						previousPill.stopDate = intervalStop;
						previousPill.aggregatedPills = previousPill.aggregatedPills.concat(pillsInThisInterval);
					} else {
						var newPill = {
							id: 0,
							count: pillsInThisInterval.length,
							aggregatedPills: pillsInThisInterval,
							startDate: moment.max(_.min(pillsInThisInterval, 'startDate').startDate, intervalStart),
							stopDate: moment.min(_.max(pillsInThisInterval, 'stopDate').stopDate, intervalStop),
						};
						if (self.consolidate && self.consolidationParams.field) {
							newPill.consolidationValue = pillsInThisInterval.reduce(
								function (sum, pill) {
									if (!pill[self.consolidationParams.excludeField]) {
										return sum + pill[self.consolidationParams.field];
									}
									return sum;
								},
								0
							);
							newPill.consolidationMaxValue = self.consolidationParams.maxValue;
							newPill.consolidationExceeded = newPill.consolidationValue > newPill.consolidationMaxValue;
						}
						pills.push(newPill);
					}
				}
				return pills;
			}, []);

			var maxCount = _.max(this.pills, function (pill) {
				return pill.count;
			}).count;
			var minColor = 215;
			var maxColor = 100;
			this.pills.forEach(function (pill) {
				pill.consolidated = true;
				if (self.consolidate && self.consolidationParams.maxValue) {
					pill.status = pill.consolidationExceeded ? 'danger' : 'success';
					pill.display_name = pill.consolidationValue;
				} else {
					var color = minColor - ((pill.count - 1) / maxCount) * (minColor - maxColor);
					pill.style = _.str.sprintf("background-color: rgba(%s, %s, %s, 0.6)", color, color, color);
					pill.display_name = pill.count;
				}
			});
		},
		_calculateMarginAndWidth: function () {
			var self = this;
			var left;
			var diff;
			this.pills.forEach(function (pill) {
				switch (self.state.scale) {
					case 'day':
						left = pill.startDate.diff(pill.startDate.clone().startOf('hour'), 'minutes');
						pill.leftMargin = (left / 60) * 100;
						diff = pill.stopDate.diff(pill.startDate, 'minutes');
						var gapSize = pill.stopDate.diff(pill.startDate, 'hours') - 1;
						pill.width = gapSize > 0 ? 'calc(' + (diff / 60) * 100 + '% + ' + gapSize + 'px)' : (diff / 60) * 100 + '%';
						break;
					case 'week':
					case 'month':
						left = pill.startDate.diff(pill.startDate.clone().startOf('day'), 'hours');
						pill.leftMargin = (left / 24) * 100;
						diff = pill.stopDate.diff(pill.startDate, 'hours');
						var gapSize = pill.stopDate.diff(pill.startDate, 'days') - 1;
						pill.width = gapSize > 0 ? 'calc(' + (diff / 24) * 100 + '% + ' + gapSize + 'px)' : (diff / 24) * 100 + '%';
						break;
					case 'year':
						var startDateMonthStart = pill.startDate.clone().startOf('month');
						var stopDateMonthEnd = pill.stopDate.clone().endOf('month');
						left = pill.startDate.diff(startDateMonthStart, 'days');
						pill.leftMargin = (left / 30) * 100;

						var monthsDiff = stopDateMonthEnd.diff(startDateMonthStart, 'months', true);
						if (monthsDiff < 1) {
							diff = Math.max(Math.ceil(pill.stopDate.diff(pill.startDate, 'days', true)), 2);
							pill.width = (diff / pill.startDate.daysInMonth()) * 100 + "%";
						} else {
							var startDateMonthEnd = pill.startDate.clone().endOf('month');
							var diffMonthStart = Math.ceil(startDateMonthEnd.diff(pill.startDate, 'days', true));
							var widthMonthStart = (diffMonthStart / pill.startDate.daysInMonth());

							var stopDateMonthStart = pill.stopDate.clone().startOf('month');
							var diffMonthStop = Math.ceil(pill.stopDate.diff(stopDateMonthStart, 'days', true));
							var widthMonthStop = (diffMonthStop / pill.stopDate.daysInMonth());

							var width = Math.max((widthMonthStart + widthMonthStop), (2 / 30)) * 100;
							if (monthsDiff > 2) {
								width += (monthsDiff - 2) * 100;
							}
							pill.width = width + "%";
						}
						break;
					default:
						break;
				}
				pill.topPadding = pill.level * (self.LEVEL_TOP_OFFSET + 1);
			});
		},
		_convertToUserTime: function (date) {
			return date.clone().local();
		},
		_evaluateDecoration: function () {
			var self = this;
			this.pills.forEach(function (pill) {
				var pillDecorations = [];
				_.each(self.viewInfo.pillDecorations, function (expr, decoration) {
					if (py.PY_isTrue(py.evaluate(expr, self._getDecorationEvalContext(pill)))) {
						pillDecorations.push(decoration);
					}
				});
				pill.decorations = pillDecorations;

				if (self.colorField) {
					pill._color = self._getColor(pill[self.colorField]);
				}

				if (self.progressField) {
					pill._progress = pill[self.progressField] || 0;
				}
			});
		},
		_getColor: function (value) {
			if (_.isNumber(value)) {
				return Math.round(value) % this.NB_GANTT_RECORD_COLORS;
			} else if (_.isArray(value)) {
				return value[0] % this.NB_GANTT_RECORD_COLORS;
			}
			return 0;
		},
		_getDecorationEvalContext: function (pillData) {
			return Object.assign(
				pyUtils.context(),
				session.user_context,
				this._getPillEvalContext(pillData),
			);
		},
		_getDiff: function (resizeSnappingWidth, gridOffset) {
			return Math.round(gridOffset / resizeSnappingWidth) * this.viewInfo.activeScaleInfo.interval;
		},
		_getPillEvalContext: function (pillData) {
			var pillContext = _.clone(pillData);
			for (var fieldName in pillContext) {
				if (this.fieldsInfo[fieldName]) {
					var fieldType = this.fieldsInfo[fieldName].type;
					if (pillContext[fieldName]._isAMomentObject) {
						pillContext[fieldName] = pillContext[fieldName].format(pillContext[fieldName].f);
					}
					else if (fieldType === 'date' || fieldType === 'datetime') {
						if (pillContext[fieldName]) {
							pillContext[fieldName] = JSON.parse(JSON.stringify(pillContext[fieldName]));
						}
						continue;
					}
				}
			}
			return pillContext;
		},
		_getPopoverContext: function (pillID) {
			var data = _.clone(_.findWhere(this.pills, { id: pillID }));
			data.userTimezoneStartDate = this._convertToUserTime(data[this.state.dateStartField]);
			data.userTimezoneStopDate = this._convertToUserTime(data[this.state.dateStopField]);
			return data;
		},
		_getResizeSnappingWidth: function (firstCell) {
			if (!this.firstCell) {
				this.firstCell = firstCell || $('.o_gantt_view .o_gantt_header_scale .o_gantt_header_cell:first')[0];
			}
			return this.firstCell.getBoundingClientRect().width / this.cellPart;
		},
		_insertIntoSlot: function () {
			var slotsToFill = this.slots;
			this.pills.forEach(function (currentPill) {
				var skippedSlots = [];
				slotsToFill.some(function (currentSlot) {
					var fitsInThisSlot = currentPill.startDate < currentSlot.stop;
					if (fitsInThisSlot) {
						currentSlot.pills.push(currentPill);
					} else {
						skippedSlots.push(currentSlot);
					}
					return fitsInThisSlot;
				});
				slotsToFill = _.difference(slotsToFill, skippedSlots);
			});
		},
		_prepareSlots: function () {
			const { interval, time, cellPrecisions } = this.SCALES[this.state.scale];
			const precision = this.viewInfo.activeScaleInfo.precision;
			const cellTime = cellPrecisions[precision];

			function getSlotStyle(cellPart, subSlotUnavailabilities, isToday) {
				function color(d) {
					if (isToday) {
						return d ? '#f4f3ed' : '#fffaeb';
					}
					return d ? '#e9ecef' : '#ffffff';
				}
				const sum = subSlotUnavailabilities.reduce((acc, d) => acc + d);
				if (!sum) {
					return '';
				}
				if (cellPart === sum) {
					return `background: ${color(1)}`;
				}
				if (cellPart === 2) {
					const [c0, c1] = subSlotUnavailabilities.map(color);
					return `background: linear-gradient(90deg, ${c0} 49%, ${c1} 50%);`
				}
				if (cellPart === 4) {
					const [c0, c1, c2, c3] = subSlotUnavailabilities.map(color);
					return `background: linear-gradient(90deg, ${c0} 24%, ${c1} 25%, ${c1} 49%, ${c2} 50%, ${c2} 74%, ${c3} 75%);`
				}
			}
			this.slots = [];
			let index = 0;
			for (const date of this.viewInfo.slots) {
				const slotStart = date;
				const slotStop = date.clone().add(1, interval);
				const isToday = date.isSame(new Date(), 'day') && this.state.scale !== 'day';

				let slotStyle = '';
				if (!this.isGroup && this.unavailabilities.slice(index).length) {
					let subSlotUnavailabilities = [];
					for (let j = 0; j < this.cellPart; j++) {
						const subSlotStart = date.clone().add(j * cellTime, time);
						const subSlotStop = date.clone().add((j + 1) * cellTime, time).subtract(1, 'seconds');
						let subSlotUnavailable = 0;
						for (let i = index; i < this.unavailabilities.length; i++) {
							let u = this.unavailabilities[i];
							if (subSlotStop > u.stopDate) {
								index++;
							} else if (u.startDate <= subSlotStart) {
								subSlotUnavailable = 1;
								break;
							}
						}
						subSlotUnavailabilities.push(subSlotUnavailable);
					}
					slotStyle = getSlotStyle(this.cellPart, subSlotUnavailabilities, isToday);
				}

				this.slots.push({
					isToday: isToday,
					style: slotStyle,
					hasButtons: !this.isGroup && !this.isTotal,
					start: slotStart,
					stop: slotStop,
					pills: [],
				});
			}
		},
		_saveDragChanges: function (pillId, diff, oldGroupId, newGroupId, action) {
			this.trigger_up('pill_dropped', {
				pillId: pillId,
				diff: diff,
				oldGroupId: oldGroupId,
				newGroupId: newGroupId,
				groupLevel: this.groupLevel,
				action: action,
			});
		},
		_saveResizeChanges: function (pillID, resizeDiff, direction) {
			var pill = _.findWhere(this.pills, { id: pillID });
			var data = { id: pillID };
			if (direction === 'left') {
				data.field = this.state.dateStartField;
				data.date = pill[this.state.dateStartField].clone().subtract(resizeDiff, this.viewInfo.activeScaleInfo.time);
			} else {
				data.field = this.state.dateStopField;
				data.date = pill[this.state.dateStopField].clone().add(resizeDiff, this.viewInfo.activeScaleInfo.time);
			}
			this.trigger_up('pill_resized', data);
		},
		_setDraggable: function ($pill) {
			if ($pill.hasClass('ui-draggable-dragging')) {
				return;
			}

			var self = this;
			var pill = _.findWhere(this.pills, { id: $pill.data('id') });

			if (this.options.canEdit && !pill.disableStartResize && !pill.disableStopResize && !this.isGroup) {

				const resizeSnappingWidth = this._getResizeSnappingWidth();

				if ($pill.draggable("instance")) {
					return;
				}
				if (!this.$containment) {
					this.$containment = $('#o_gantt_containment');
				}
				$pill.draggable({
					containment: this.$containment,
					start: function (event, ui) {
						self.trigger_up('updating_pill_started');

						const pillWidth = $pill[0].getBoundingClientRect().width;
						ui.helper.css({ width: pillWidth });
						ui.helper.removeClass('position-relative');

						self.trigger_up('start_dragging', {
							$draggedPill: $pill,
							$draggedPillClone: ui.helper,
						});

						self.$el.addClass('o_gantt_dragging');
						$pill.popover('hide');
						self.$('.o_gantt_pill').popover('disable');
					},
					drag: function (event, ui) {
						if ($(event.target).hasClass('o_gantt_pill_editing')) {
							return false;
						}
						var diff = self._getDiff(resizeSnappingWidth, ui.position.left);
						self._updateResizeBadge(ui.helper, diff, ui);

						const pointObject = { x: event.pageX, y: event.pageY };
						const options = { container: document.body };
						const $el = $.nearest(pointObject, '.o_gantt_hoverable', options).first();
						if ($el.length) {
							$('.o_gantt_hoverable').removeClass('ui-drag-hover');
							$el.addClass('ui-drag-hover');
						}
					},
					stop: function () {
						self.trigger_up('updating_pill_stopped');
						self.trigger_up('stop_dragging');

						self.$('.ui-drag-hover').removeClass('ui-drag-hover');
						self.$el.removeClass('o_gantt_dragging');
						self.$('.o_gantt_pill').popover('enable');
						
						//Customized for remove all Pills Unwanted Popovers
						self.$('.o_gantt_pill').popover('dispose');
						$pill.popover('dispose');
					},
					helper: 'clone',
				});
			} else {
				if ($pill.draggable("instance")) {
					return;
				}
				if (!this.$lockIndicator) {
					this.$lockIndicator = $('<div class="fa fa-lock"/>').css({
						'z-index': 20,
						position: 'absolute',
						top: '4px',
						right: '4px',
					});
				}
				$pill.draggable({
					grid: [0, 0],
					start: function () {
						self.trigger_up('updating_pill_started');
						self.trigger_up('start_no_dragging');
						$pill.popover('hide');
						self.$('.o_gantt_pill').popover('disable');
						self.$lockIndicator.appendTo($pill);
					},
					drag: function () {
						if ($(event.target).hasClass('o_gantt_pill_editing')) {
							return false;
						}
					},
					stop: function () {
						self.trigger_up('updating_pill_stopped');
						self.trigger_up('stop_no_dragging');
						self.$('.o_gantt_pill').popover('enable');
						self.$lockIndicator.detach();
					},
				});
				$pill.addClass('o_fake_draggable');
			}
		},
		_setResizable: function ($pill) {
			if ($pill.hasClass('ui-resizable')) {
				return;
			}
			var self = this;
			var pillHeight = this.$('.o_gantt_pill:first').height();

			var pill = _.findWhere(self.pills, { id: $pill.data('id') });

			const resizeSnappingWidth = this._getResizeSnappingWidth();

			var handles = [];
			if (!pill.disableStartResize) {
				handles.push('w');
			}
			if (!pill.disableStopResize) {
				handles.push('e');
			}
			if (handles.length && !self.options.disableResize && !self.isGroup && self.options.canEdit) {
				$pill.resizable({
					handles: handles.join(', '),
					grid: [resizeSnappingWidth, pillHeight],
					start: function () {
						$pill.popover('hide');
						self.$('.o_gantt_pill').popover('disable');
						self.trigger_up('updating_pill_started');
						self.$el.addClass('o_gantt_dragging');
					},
					resize: function (event, ui) {
						var diff = Math.round((ui.size.width - ui.originalSize.width) / resizeSnappingWidth * self.viewInfo.activeScaleInfo.interval);
						self._updateResizeBadge($pill, diff, ui);
					},
					stop: function (event, ui) {
						setTimeout(() => {
							self.trigger_up('updating_pill_stopped');
							self.$el.removeClass('o_gantt_dragging');
							self.$('.o_gantt_pill').popover('enable');
						});
						var diff = Math.round((ui.size.width - ui.originalSize.width) / resizeSnappingWidth * self.viewInfo.activeScaleInfo.interval);
						var direction = ui.position.left ? 'left' : 'right';
						if (diff) {
							self._saveResizeChanges(pill.id, diff, direction);
						}
					},
				});
			}
		},
		_snapToGrid: function (timeSpans) {
			var self = this;
			var interval = this.viewInfo.activeScaleInfo.interval;
			switch (this.state.scale) {
				case 'day':
					timeSpans.forEach(function (span) {
						var snappedStartDate = self._snapMinutes(span.startDate, interval);
						var snappedStopDate = self._snapMinutes(span.stopDate, interval);
						var minuteDiff = snappedStartDate.diff(snappedStopDate, 'minute');
						if (minuteDiff === 0) {
							if (snappedStartDate > span.startDate) {
								span.startDate = snappedStartDate.subtract(interval, 'minute');
								span.stopDate = snappedStopDate;
							} else {
								span.startDate = snappedStartDate;
								span.stopDate = snappedStopDate.add(interval, 'minute');
							}
						} else {
							span.startDate = snappedStartDate;
							span.stopDate = snappedStopDate;
						}
					});
					break;
				case 'week':
				case 'month':
					timeSpans.forEach(function (span) {
						var snappedStartDate = self._snapHours(span.startDate, interval);
						var snappedStopDate = self._snapHours(span.stopDate, interval);
						var hourDiff = snappedStartDate.diff(snappedStopDate, 'hour');
						if (hourDiff === 0) {
							if (snappedStartDate.diff(span.startDate, 'hours') > 2 && span.stopDate.diff(snappedStopDate, 'hours') > 2) {
								span.startDate = snappedStartDate.subtract(interval, 'hour');
								span.stopDate = snappedStopDate.add(interval, 'hour');
							} else if (snappedStartDate > span.startDate) {
								span.startDate = snappedStartDate.subtract(interval, 'hour');
								span.stopDate = snappedStopDate;
							} else {
								span.startDate = snappedStartDate;
								span.stopDate = snappedStopDate.add(interval, 'hour');
							}
						} else {
							if (snappedStartDate.diff(span.startDate, 'hours') > 2) {
								snappedStartDate = snappedStartDate.subtract(interval, 'hour');
							}
							if (span.stopDate.diff(snappedStopDate, 'hours') > 2) {
								snappedStopDate = snappedStopDate.add(interval, 'hour');
							}
							span.startDate = snappedStartDate;
							span.stopDate = snappedStopDate;
						}
					});
					break;
				case 'year':
					timeSpans.forEach(function (span) {
						span.startDate = span.startDate.clone().startOf('month');
						span.stopDate = span.stopDate.clone().endOf('month');
					});
					break;
				default:
					break;
			}
		},
		_snapHours: function (date, interval) {
			var snappedHours = Math.round(date.clone().hour() / interval) * interval;
			return date.clone().hour(snappedHours).minute(0).second(0);
		},
		_snapMinutes: function (date, interval) {
			var snappedMinutes = Math.round(date.clone().minute() / interval) * interval;
			return date.clone().minute(snappedMinutes).second(0);
		},
		_updateResizeBadge: function ($pill, diff, ui) {
			$pill.find('.o_gantt_pill_resize_badge').remove();
			if (diff) {
				var direction = ui.position.left ? 'left' : 'right';
				$(QWeb.render('native_project_gantt.ResizeBadge', {
					diff: diff,
					direction: direction,
					time: this.viewInfo.activeScaleInfo.time,
				}), { css: { 'z-index': 2 } })
					.appendTo($pill);
			}
		},
		_onButtonAddClicked: function (ev) {
			var date = moment($(ev.currentTarget).closest('.o_gantt_cell').data('date'));
			this.trigger_up('add_button_clicked', {
				date: date,
				groupId: this.groupId,
			});
		},
		_onButtonPlanClicked: function (ev) {
			var date = moment($(ev.currentTarget).closest('.o_gantt_cell').data('date'));
			this.trigger_up('plan_button_clicked', {
				date: date,
				groupId: this.groupId,
			});
		},
		_onMouseMove: function (ev) {
			if ((this.options.canCreate || this.options.canEdit) &&
				!this.$el[0].classList.contains('o_gantt_dragging')) {
				var elementsFromPoint = function (x, y) {
					if (document.elementsFromPoint)
						return document.elementsFromPoint(x, y);
					if (document.msElementsFromPoint) {
						return Array.prototype.slice.call(document.msElementsFromPoint(x, y));
					}
				};

				var hoveredCell;
				if (ev.target.classList.contains('o_gantt_pill') || ev.target.parentNode.classList.contains('o_gantt_pill')) {
					elementsFromPoint(ev.pageX, ev.pageY).some(function (element) {
						return element.classList.contains('o_gantt_cell') ? ((hoveredCell = element), true) : false;
					});
				} else {
					hoveredCell = ev.currentTarget;
				}

				if (hoveredCell && hoveredCell != this.lastHoveredCell) {
					if (this.lastHoveredCell) {
						this.lastHoveredCell.classList.remove('o_hovered');
					}
					hoveredCell.classList.add('o_hovered');
					this.lastHoveredCell = hoveredCell;
				}
			}
		},
		_onMouseLeave: function () {
			this.$(".o_gantt_cell.o_hovered").removeClass('o_hovered');
			this.lastHoveredCell = undefined;
		},
		_onPillClicked: function (ev) {
			if (!this.isGroup) {
				this.trigger_up('pill_clicked', {
					target: $(ev.currentTarget),
				});
			}
		},
		_onPillEntered: function (ev) {
			var $pill = $(ev.currentTarget);

			this._setResizable($pill);
			if (!this.isTotal) {
				this._setDraggable($pill);
			}
			if (!this.isGroup) {
				this._bindPillPopover(ev.target);
			}
		},
		_onRowSidebarClicked: function () {
			if (this.isGroup & !this.isTotal) {
				if (this.isOpen) {
					this.trigger_up('collapse_row', { rowId: this.rowId });
				} else {
					this.trigger_up('expand_row', { rowId: this.rowId });
				}
			}
		},
	});
	return NativeProjectGanttRow;
});;