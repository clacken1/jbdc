# -*- coding: utf-8 -*-
#################################################################################
# Author      : CodersFort (<https://codersfort.com/>)
# Copyright(c): 2017-Present CodersFort.
# All Rights Reserved.
#
#
#
# This program is copyright property of the author mentioned above.
# You can`t redistribute it and/or modify it.
#
#
# You should have received a copy of the License along with this program.
# If not, see <https://codersfort.com/>
#################################################################################

{
    "name": "Project Gantt View",
    "summary": "Project Gantt View Module helps you show what task is scheduled to be done on a specific day.",
    "version": "14.0.1",
    "description": """
        Project Gantt View Module helps you show what task is scheduled to be done on a specific day.
        Project Planning.
        Project Schedule.
        Project Gantt.
        Schedule Project Task.
        Project Task Gantt Schedule.
        Drag and drop records.
        Project progress.
        Four Modes of view.  
    """,    
    "author": "CodersFort",
    "maintainer": "Ananthu Krishna",
    "license" :  "Other proprietary",
    "website": "http://www.codersfort.com",
    "images": ["images/native_project_gantt.png"],
    "category": "Project",
    "depends": [
        "web",
        "project"
    ],
    "data": [      
        "views/assets.xml",                
        "views/project_views.xml",
    ],
    "qweb": [
        "static/src/xml/native_project_gantt.xml",
    ],
    "installable": True,
    "application": True,
    "price"                :  35,
    "currency"             :  "EUR",
    "pre_init_hook"        :  "pre_init_check",   
}