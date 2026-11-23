import { defineWalkthrough } from "@dap/walkthrough";
export const findSecuritySettings=defineWalkthrough({id:"findSecuritySettings",title:"Find the security settings",description:"Open the settings page and locate the security panel.",start:"settings",steps:[
 {id:"settings",kind:"navigate",route:"settings",next:"security"},
 {id:"security",kind:"guide",target:"settings.securityPanel",wait:"ack",text:"Your security settings are in this Security section.",next:"done"},
 {id:"done",kind:"complete",text:"You found the Security section. This guide changed nothing."},
]});
