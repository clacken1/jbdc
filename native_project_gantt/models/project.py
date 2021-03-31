from datetime import date, datetime, timedelta, time
import pytz

from odoo import api, fields, models, _
from odoo.exceptions import UserError
 
class ProjectTask(models.Model):
    _inherit = "project.task"

    def _default_start_datetime(self):
        return datetime.combine(fields.Datetime.now(), datetime.min.time())

    def _default_end_datetime(self):
        return datetime.combine(fields.Datetime.now(), datetime.max.time())
    
    start_datetime = fields.Datetime(
        "Start Date", store=True, readonly=False, required=True,
        copy=True, default=_default_start_datetime)
    end_datetime = fields.Datetime(
        "End Date", store=True, readonly=False, required=True,
        copy=True, default=_default_end_datetime)
    progress = fields.Float('Progress', readonly=True)    
    gantt_color = fields.Integer('Project color', default=4)
    
    _sql_constraints = [
        ('planned_dates_check', "CHECK ((start_datetime <= end_datetime))", "The planned start date must be prior to the planned end date."),
    ]
    
    @api.model
    def gantt_unavailability(self, start_date, end_date, scale, group_bys=None, rows=None):
        start_datetime = fields.Datetime.from_string(start_date)
        end_datetime = fields.Datetime.from_string(end_date)
        user_ids = set()

        # function to "mark" top level rows concerning users
        # the propagation of that user_id to subrows is taken care of in the traverse function below
        def tag_user_rows(rows):
            for row in rows:
                group_bys = row.get('groupedBy')
                res_id = row.get('resId')
                if group_bys:
                    # if user_id is the first grouping attribute
                    if group_bys[0] == 'user_id' and res_id:
                        user_id = res_id
                        user_ids.add(user_id)
                        row['user_id'] = user_id
                    # else we recursively traverse the rows
                    elif 'user_id' in group_bys:
                        tag_user_rows(row.get('rows'))

        tag_user_rows(rows)
        resources = self.env['res.users'].browse(user_ids).mapped('resource_ids').filtered(lambda r: r.company_id.id == self.env.company.id)
        # we reverse sort the resources by date to keep the first one created in the dictionary
        # to anticipate the case of a resource added later for the same employee and company
        user_resource_mapping = {resource.user_id.id : resource.id for resource in resources.sorted('create_date', True)}
        leaves_mapping = resources._get_unavailable_intervals(start_datetime, end_datetime)

        # function to recursively replace subrows with the ones returned by func
        def traverse(func, row):
            new_row = dict(row)
            if new_row.get('user_id'):
                for sub_row in new_row.get('rows'):
                    sub_row['user_id'] = new_row['user_id']
            new_row['rows'] = [traverse(func, row) for row in new_row.get('rows')]
            return func(new_row)

        cell_dt = timedelta(hours=1) if scale in ['day', 'week'] else timedelta(hours=12)

        # for a single row, inject unavailability data
        def inject_unavailability(row):
            new_row = dict(row)
            user_id = row.get('user_id')
            if user_id:
                resource_id = user_resource_mapping.get(user_id)
                if resource_id:
                    # remove intervals smaller than a cell, as they will cause half a cell to turn grey
                    # ie: when looking at a week, a employee start everyday at 8, so there is a unavailability
                    # like: 2019-05-22 20:00 -> 2019-05-23 08:00 which will make the first half of the 23's cell grey
                    notable_intervals = filter(lambda interval: interval[1] - interval[0] >= cell_dt, leaves_mapping[resource_id])
                    new_row['unavailabilities'] = [{'start': interval[0], 'stop': interval[1]} for interval in notable_intervals]
            return new_row

        return [traverse(inject_unavailability, row) for row in rows]
    