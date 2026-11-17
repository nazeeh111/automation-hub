import {expect} from '@playwright/test';

// The same destinations remain directly available on desktop. Folded layouts
// expose them through the explicit menu; opening it never changes the workspace.
export async function openNavigation(page){
 const trigger=page.getByRole('button',{name:'Open navigation',exact:true});
 if(await trigger.isVisible()){
  if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
  await expect(page.getByRole('dialog',{name:'Workspace navigation',exact:true})).toBeVisible();
 }
}
export async function closeNavigation(page){
 const trigger=page.getByRole('button',{name:'Open navigation',exact:true});
 if(await trigger.isVisible()&&await trigger.getAttribute('aria-expanded')==='true'){
  await page.keyboard.press('Escape');await expect(trigger).toHaveAttribute('aria-expanded','false');await expect(trigger).toBeFocused();
 }
}
export async function navigateTo(page,name){
 await openNavigation(page);
 await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name,exact:true}).click();
}
export async function workspaceSection(page,id){
 await openNavigation(page);
 await page.locator(`#workspace-tab-${id}`).click();
}
