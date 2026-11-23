import { defineWalkthrough } from "@dap/walkthrough";
export const profileUpdate=defineWalkthrough({id:"profileUpdate",title:"Update your profile name",description:"Change the display name on your profile and save it.",start:"profile",steps:[
 {id:"profile",kind:"navigate",route:"profile",next:"name"},
 {id:"name",kind:"guide",target:"profile.nameInput",wait:"input",text:"Type your display name here.",next:"save"},
 {id:"save",kind:"guide",target:"profile.saveButton",wait:"click",verify:"profile.saved",text:"Press Save to store your name.",next:"done",recover:"fixName"},
 {id:"done",kind:"complete",text:"Your display name was saved. You finished this guide."},
 {id:"fixName",kind:"guide",maxAttempts:2,target:"profile.nameInput",wait:"input",text:"Saving did not work. Use 2 to 80 characters, change the name, then continue.",next:"save"},
]});
