from odoo import api, fields, models

class ViewGantt(models.Model):
    _inherit = 'ir.ui.view'
    
    type = fields.Selection(selection_add=[('ganttview', 'Gantt View')])