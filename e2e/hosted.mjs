// Browser check of a hosted deployment that fetches from the fake IONOS API
// (ionos-fakeapi, token demo-token):
//
//   node hosted.mjs setup <setup link>   creates the first admin, fetches, logs out
//   node hosted.mjs login <public URL>   logs that admin in again, fetches, logs out
//
// Fails on a page error, a console error, or a request to any other origin.
// On failure a screenshot lands in e2e/results/.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const [mode, target] = process.argv.slice(2)
if (!['setup', 'login'].includes(mode) || !target) {
  console.error('usage: node hosted.mjs setup <setup link> | login <public URL>')
  process.exit(2)
}
const base = (mode === 'setup' ? target.split('#')[0] : target).replace(/\/$/, '')
const user = 'e2e-admin'
const password = 'correct horse battery staple' // a test value for a throwaway deployment
const token = process.env.E2E_TOKEN ?? 'demo-token'

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true })
const page = await ctx.newPage()
page.setDefaultTimeout(30000)
const problems = []
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
page.on('request', (r) => {
  const u = r.url()
  if (!u.startsWith(base + '/') && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`request elsewhere: ${u}`)
})
const step = (s) => console.log(`e2e ${mode}: ${s}`)

try {
  if (mode === 'setup') {
    await page.goto(target)
    await page.getByLabel('Username', { exact: true }).fill(user)
    await page.getByLabel('New password', { exact: true }).fill(password)
    await page.getByLabel('New password again').fill(password)
    await page.getByRole('button', { name: 'Create and log in' }).click()
  } else {
    await page.goto(base + '/')
    await page.getByLabel('Username', { exact: true }).fill(user)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Log in' }).click()
  }
  await page.getByRole('heading', { name: 'Fetch from IONOS' }).waitFor()
  step('logged in')

  await page.getByLabel('IONOS API token').fill(token)
  await page.getByRole('button', { name: 'Fetch', exact: true }).click()
  await page.locator('.dg-dc').first().waitFor({ timeout: 90000 })
  const dcs = await page.locator('.dg-dc').count()
  if (dcs < 1) throw new Error('no datacenters on the canvas')
  step(`fetched, ${dcs} datacenters on the canvas`)

  await page.locator('.topbar-actions').getByRole('button', { name: new RegExp(user) }).click()
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Log out', exact: true }).click()
  await page.getByRole('form', { name: 'Log in' }).waitFor()
  step('logged out')

  // 400/401 answers the page handles itself would show here; there are none in this flow.
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`e2e ${mode}: ok`)
} catch (e) {
  mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
  await page.screenshot({ path: new URL(`./results/${mode}-failure.png`, import.meta.url).pathname, fullPage: true }).catch(() => {})
  console.error(`e2e ${mode}: FAILED\n${e instanceof Error ? e.message : e}`)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
}
