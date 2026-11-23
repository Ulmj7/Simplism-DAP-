import { defineWalkthrough } from "@dap/walkthrough";
export const findTwoFactorSettings=defineWalkthrough({id:"findTwoFactorSettings",title:"Find the two-factor authentication settings",description:"Open the settings page and locate the two-factor authentication option.",start:"settings",steps:[
 {id:"settings",kind:"navigate",route:"settings",next:"twoFactor"},
 {id:"twoFactor",kind:"guide",target:"settings.twoFactorSetup",wait:"ack",targetWaitMs:400,recover:"openAdvanced",text:"Two-factor authentication settings are located here.",next:"done"},
 {id:"openAdvanced",kind:"guide",target:"settings.advancedToggle",wait:"click",verify:"settings.advancedOpen",text:"The two-factor option is inside Advanced. Open Advanced.",next:"twoFactor"},
 {id:"done",kind:"complete",text:"You found the two-factor option. This demo changed no authentication settings."},
]});
