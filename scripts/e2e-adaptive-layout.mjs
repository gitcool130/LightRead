import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
const base=process.env.E2E_BASE ?? 'http://localhost:4173',out='/tmp/lightread-adaptive'
mkdirSync(out,{recursive:true})
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:392,height:872},isMobile:true,hasTouch:true,deviceScaleFactor:2.75})
page.setDefaultTimeout(15000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const state=()=>page.evaluate(()=>{const s=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings'),r=document.querySelector('foliate-view')?.renderer;return {orientation:s.screenPreset.orientation,reader:JSON.parse(JSON.stringify(s.readerPrefs)),raw:JSON.parse(JSON.stringify(s.reader)),manual:JSON.parse(JSON.stringify(s.layoutOverrides)),flow:r?.getAttribute('flow'),columns:r?.getAttribute('column-count'),columnCount:r?.columnCount,gap:r?.getAttribute('gap')}})
const waitLayout=async(flow,columns)=>{console.log('layout',flow,columns);return page.waitForFunction(({flow,columns})=>{const r=document.querySelector('foliate-view')?.renderer;return r?.getAttribute('flow')===flow&&r?.getAttribute('column-count')===String(columns)},{flow,columns})}
try {
 await page.goto(base+'/#/library')
 await page.locator('input[type=file][multiple]').setInputFiles({name:'横竖屏验收.txt',mimeType:'text/plain',buffer:Buffer.from('第一章 窗口排版\n\n'+'窗外是一片安静的树林，读者沿着文字慢慢往下读。\n\n'.repeat(200))})
 await page.locator('.book-card',{hasText:'横竖屏验收'}).click()
 await page.waitForFunction(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().length)
 const mobile = await page.locator('.listen-entry').count() > 0
 await waitLayout('scrolled',1);let s=await state();assert.equal(s.reader.fontSize,mobile ? 19 : 18)
 const initial=s.raw
 await page.setViewportSize({width:1280,height:800});await waitLayout('paginated',2);s=await state();assert.equal(s.reader.fontSize,20);assert.deepEqual(s.raw,initial)
 await page.setViewportSize({width:872,height:392});await waitLayout('paginated',1)
 await page.setViewportSize({width:392,height:872});await waitLayout('scrolled',1)
 await page.locator('.dock button',{hasText:'排版'}).click()
 const font=page.locator('.settings-pop input[type=number]');await font.fill('18');await font.dispatchEvent('change')
 if (mobile) await page.getByRole('tab',{name:'页面',exact:true}).click()
 await page.locator('.tp-flows button').first().click();await waitLayout('paginated',1)
 await page.getByRole('button',{name:'双栏',exact:true}).click();await waitLayout('paginated',2)
 if (mobile) await page.getByRole('tab',{name:'文字',exact:true}).click()
 await page.locator('.settings-pop input[type=range][aria-label="边距"]').fill('10')
 await page.locator('.tp-close').click()
 await page.setViewportSize({width:1280,height:800});await waitLayout('paginated',2);s=await state();assert.equal(s.reader.fontSize,18);assert.equal(s.reader.gap,10)
 await page.waitForTimeout(400);await page.reload();await waitLayout('paginated',2);s=await state();assert.equal(s.reader.fontSize,18);assert.equal(s.reader.gap,10)
 await page.setViewportSize({width:392,height:872});await waitLayout('paginated',2)
 console.log('PASS auto portrait/landscape/short landscape, raw preferences unchanged, manual equal-default/font/margin/columns preserved across resize and reload')
 await page.keyboard.press('m');await page.locator('.rm-panel').waitFor()
 await page.locator('[data-guide=lyric] .rm-gear').click();await page.locator('[data-guide=lyric] .rm-more summary').click()
 const lines=page.locator('.rm-lines-input'),pos=page.locator('.rm-position-input')
 await lines.fill('7');await lines.press('Enter');assert.equal(await lines.inputValue(),'7')
 await pos.fill('0.618');await pos.press('Enter');assert.equal(await pos.inputValue(),'0.618')
 await page.locator('.rm-card-info').first().click()
 await page.locator('.rm-detail input[type=checkbox]').first().check()
 for(const width of [320,392,1280]) {
  await page.setViewportSize({width,height:width===1280?800:872})
  for(const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme)
   for(const selector of ['.rm-speed-input','.rm-lines-input','.rm-position-input','.rm-time']) {
    if (mobile && selector !== '.rm-time') {
     const gear=page.locator(`[data-guide=${selector === '.rm-speed-input' ? 'auto' : 'lyric'}] .rm-gear`)
     if(await gear.getAttribute('aria-expanded') !== 'true') await gear.click()
    }
    const el=page.locator(selector).first();await el.scrollIntoViewIfNeeded()
    const metrics=await el.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {height:r.height,width:r.width,border:s.borderStyle,font:parseFloat(s.fontSize),right:r.right,left:r.left}})
    assert(metrics.height>=44,JSON.stringify({selector,width,metrics}));assert.equal(metrics.border,'solid');assert(metrics.font>=16);assert(metrics.left>=0&&metrics.right<=width)
   }
   await pos.focus();await page.screenshot({path:`${out}/mode-${width}-${theme}.png`})
  }
 }
 // 新上下文验证 PDF 自动预设及独立的手动缩放, 不继承正文验收设置。
 const pdfPage=await browser.newPage({viewport:{width:1280,height:800}})
 pdfPage.on('pageerror',e=>errors.push(e.message))
 await pdfPage.goto(base+'/#/library')
 const body='BT /F1 18 Tf 60 700 Td (Adaptive PDF layout) Tj ET'
 const pdf=`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${body.length} >> stream
${body}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
trailer << /Root 1 0 R /Size 7 >>
%%EOF`
 await pdfPage.locator('input[type=file][multiple]').setInputFiles({name:'adaptive.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdf)})
 await pdfPage.locator('.book-card',{hasText:'adaptive'}).click()
 await pdfPage.locator('.paged-box canvas').first().waitFor()
 // 桌面顶栏: 阅读方式 / 页面视图 / 适配收在「视图」面板里
 const pdfView=async name=>{if(!await pdfPage.locator('.view-panel').count())await pdfPage.locator('.view-trigger').click();await pdfPage.locator('.view-panel').getByRole('button',{name,exact:true}).click();if(await pdfPage.locator('.view-panel').count())await pdfPage.keyboard.press('Escape');await pdfPage.locator('.view-panel').waitFor({state:'detached'})}
 await pdfPage.locator('.view-trigger').click()
 assert.equal(await pdfPage.getByRole('button',{name:'对页',exact:true}).getAttribute('aria-pressed'),'true')
 assert.equal(await pdfPage.getByRole('button',{name:'适高',exact:true}).getAttribute('aria-pressed'),'true')
 await pdfPage.keyboard.press('Escape')
 const pdfState=()=>pdfPage.evaluate(()=>{const s=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings');return JSON.parse(JSON.stringify({raw:s.pdf,flags:s.layoutOverrides.pdf}))})
 const initialPdf=await pdfState()
 await pdfPage.setViewportSize({width:392,height:872})
 await pdfPage.locator('.pane-left canvas').first().waitFor()
 await pdfPage.waitForFunction(()=>document.querySelector('.dock-zoom')?.textContent.includes('适宽'))
 assert.deepEqual(await pdfState(),initialPdf)
 await pdfPage.setViewportSize({width:1280,height:800})
 await pdfPage.locator('.paged-box canvas').first().waitFor()
 await pdfView('单页')
 await pdfView('滚动')
 await pdfView('适高')
 const manualPdf=await pdfState()
 assert.deepEqual(manualPdf.flags,{mode:true,fit:true,spreadMode:true})
 await pdfView('幻灯片放映 (F5)')
 await pdfPage.locator('.paper.is-presentation').waitFor()
 await pdfPage.locator('.fullscreen-exit').click()
 await pdfPage.locator('.paper.is-presentation').waitFor({state:'detached'})
 assert.deepEqual(await pdfState(),manualPdf)
 await pdfPage.setViewportSize({width:392,height:872})
 await pdfPage.waitForTimeout(400)
 await pdfPage.reload()
 await pdfPage.locator('.pane-left canvas').first().waitFor()
 assert.deepEqual(await pdfState(),manualPdf)
 assert.match(await pdfPage.locator('.dock-zoom').textContent(),/适合页面/)
 await pdfPage.close()
 console.log('PASS PDF window presets, manual mode/fit/spread persistence and presentation restoration')
 assert.deepEqual(errors,[])
 console.log('PASS mode number/time fields, 320/392/1280px, light/dark, touch sizes and exact inputs')
}catch(e){console.log('STATE',await state());await page.screenshot({path:out+'/failure.png'});throw e}finally{await browser.close()}
