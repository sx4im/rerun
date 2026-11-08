#!/usr/bin/env node
// Checks `.env` before the first `docker compose up`: fills the secrets left empty, stops on what
// only you can provide, saying where to find it, then asks Supabase whether the schema is in place
// and the secret key is the right one.
//
//   node scripts/self-host-check.mjs

import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const FILE = '.env'
const TEMPLATES = ['confirmation.html', 'email_change.html', 'magic_link.html']
const GENERATED = ['RERUN_ENGINE_API_KEY', 'FOREMAN_HUB_TOKEN_SECRET', 'BOARD_IMAGE_SECRET']
const REQUIRED = {
    NEXT_PUBLIC_APP_URL: 'the address people open, e.g. http://localhost:3000',
    NEXT_PUBLIC_SUPABASE_URL: 'Supabase > Project settings > API > Project URL, or `npx supabase status` (API URL)',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'Supabase > Project settings > API keys > publishable (or anon) key',
    SUPABASE_SECRET_KEY: 'Supabase > Project settings > API keys > secret (or service_role) key',
}

if (!existsSync(FILE)) {
    console.error('No .env here. Run `cp .env.example .env` first, from the root of the repository.')
    process.exit(1)
}

let text = readFileSync(FILE, 'utf8')
const valueOf = (key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''

const generated = []
for (const key of GENERATED) {
    if (valueOf(key)) continue
    const value = randomBytes(32).toString('hex')
    text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`
    generated.push(key)
}
if (generated.length) writeFileSync(FILE, text)

const problems = []
for (const [key, where] of Object.entries(REQUIRED)) {
    if (!valueOf(key)) problems.push(`${key} is empty: ${where}`)
}
const appUrl = valueOf('NEXT_PUBLIC_APP_URL')
if (appUrl && (!/^https?:\/\//.test(appUrl) || appUrl.endsWith('/'))) problems.push('NEXT_PUBLIC_APP_URL must start with http:// or https:// and end without a slash')
const supabaseUrl = valueOf('NEXT_PUBLIC_SUPABASE_URL')
if (supabaseUrl && /127\.0\.0\.1|localhost/.test(supabaseUrl) && !/:54421\b/.test(supabaseUrl)) problems.push('A local Supabase answers on port 54421 here: use http://localhost:54421')
if (!valueOf('OPENROUTER_API_KEY')) console.warn('! OPENROUTER_API_KEY is empty: the Foreman skips the guided onboarding. It and your coworkers run on the AI you connect in the app.')

if (generated.length) console.log(`Generated ${generated.join(', ')} in .env`)
if (problems.length) {
    console.error(`\n${problems.map((problem) => `x ${problem}`).join('\n')}\n`)
    process.exit(1)
}

const supabaseProblem = await askSupabase(supabaseUrl, valueOf('SUPABASE_SECRET_KEY'))
if (supabaseProblem) {
    console.error(`\nx ${supabaseProblem}\n`)
    process.exit(1)
}

const templateProblem = emailTemplateProblem(supabaseUrl)
if (templateProblem) {
    console.error(`\nx ${templateProblem}\n`)
    process.exit(1)
}

console.log(`
.env is ready and Supabase answers. Next:
  docker compose${/localhost:54421/.test(supabaseUrl) ? ' --profile local-supabase' : ''} up -d --build
  open ${appUrl}`)

// The sign-in calls this function with the secret key before it sends any code, so it fails here the
// same way the sign-in would, with "We could not send your code" and nothing in the logs.
async function askSupabase(url, secretKey) {
    let response
    try {
        response = await fetch(`${url}/rest/v1/rpc/check_email_exists`, {
            method: 'POST',
            headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'check@rerun.build' }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch {
        return `Supabase does not answer at ${url}: check NEXT_PUBLIC_SUPABASE_URL, and that Supabase is running`
    }
    if (response.ok) return null
    const body = await response.json().catch(() => ({}))
    if (body.code === 'PGRST202') return `The database has no Rerun schema yet. Apply it, then run this check again:\n  ${schemaCommand(url)}`
    const notThisProject = 'SUPABASE_SECRET_KEY is not a key of this Supabase project: copy the secret (service_role) key from Supabase > Project settings > API keys'
    // An unknown `sb_secret_` key is served as anon by some gateways, so it is refused like the anon key.
    if (body.code === '42501') return secretKey.startsWith('sb_secret_') ? notThisProject : 'SUPABASE_SECRET_KEY holds the publishable (anon) key: put the secret (service_role) key there, from Supabase > Project settings > API keys'
    if (response.status === 401 || response.status === 403) return notThisProject
    return `Supabase answered ${response.status}: ${body.message ?? 'no detail'}`
}

function schemaCommand(url) {
    if (/:54421\b/.test(url)) return 'npx supabase db reset   (erases the data of the local stack)'
    const projectRef = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1]
    if (projectRef) return `npx supabase link --project-ref ${projectRef} && npx supabase db push --include-seed`
    return 'npx supabase db push --include-seed --yes --db-url "postgresql://postgres.rerun:<POSTGRES_PASSWORD>@127.0.0.1:5432/postgres?sslmode=disable"'
}

// With a local Supabase, Auth reads the sign-in templates from supabase/templates/
// through Kong, which serves them from the container. On a Linux machine with
// SELinux enforcing, a file checked out under $HOME carries user_home_t, which the
// container cannot read: Kong answers 403, Auth falls back to its default email,
// and the sign-in email arrives without the six-digit code. The label is what the
// container sees, so that is what this reads: a file labeled container_file_t is
// fine, anything else is not. Anything it cannot tell — no SELinux, no stat, a
// missing file — it leaves alone, so it only fails on a label it has actually seen.
function emailTemplateProblem(url) {
    if (!/127\.0\.0\.1|localhost/.test(url)) return null
    if (process.platform !== 'linux') return null
    const enforcing = spawnSync('getenforce', [], { encoding: 'utf8' })
    if (enforcing.status !== 0 || enforcing.stdout?.trim() !== 'Enforcing') return null
    const bad = []
    for (const name of TEMPLATES) {
        const file = `supabase/templates/${name}`
        if (!existsSync(file)) continue
        const label = spawnSync('stat', ['-c', '%C', file], { encoding: 'utf8' })
        if (label.status !== 0) continue
        const type = label.stdout.trim().split(':')[2]
        if (type && type !== 'container_file_t') bad.push({ file, type })
    }
    if (!bad.length) return null
    return `The sign-in email templates carry an SELinux label Kong cannot read, so Kong answers 403 and the sign-in email arrives without the six-digit code: ${bad.map(({ file, type }) => `${file} (${type})`).join(', ')}.\n  Relabel them, from the repository root:\n  chcon -t container_file_t ${bad.map(({ file }) => file).join(' ')}`
}
