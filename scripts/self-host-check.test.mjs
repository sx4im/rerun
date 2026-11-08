// End-to-end checks for scripts/self-host-check.mjs: the script runs in a throwaway
// directory against a stub Supabase (the check_email_exists RPC answers 200) and
// fake `getenforce`/`stat` binaries on PATH, so the SELinux label check can be
// exercised without SELinux.
//
//   node --test scripts/self-host-check.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./self-host-check.mjs', import.meta.url))
const TEMPLATES = ['confirmation.html', 'email_change.html', 'magic_link.html']

const ENV = `NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54421
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test
SUPABASE_SECRET_KEY=sb_secret_test
OPENROUTER_API_KEY=
`

function writeFakeBin(dir, { enforcing, labelFor }) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'getenforce'), `#!/bin/sh\necho "${enforcing ? 'Enforcing' : 'Disabled'}"\n`)
    const statBody =
        labelFor === 'fail'
            ? `#!/bin/sh\necho "stat: failed to get security context" >&2\nexit 1\n`
            : `#!/bin/sh\ncase "$3" in\n${TEMPLATES.map((name) => `  *${name}*) echo "system_u:object_r:${labelFor(name)}:s0" ;;`).join('\n')}\n  *) echo "system_u:object_r:container_file_t:s0" ;;\nesac\n`
    writeFileSync(join(dir, 'stat'), statBody)
    chmodSync(join(dir, 'getenforce'), 0o755)
    chmodSync(join(dir, 'stat'), 0o755)
}

// One stub Supabase for the whole file: it only answers the check_email_exists
// RPC, which is all the script asks of Supabase.
const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/rest/v1/rpc/check_email_exists') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
    }
    res.writeHead(404)
    res.end()
})
before(() => new Promise((resolve) => server.listen(54421, '0.0.0.0', resolve)))
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))

async function runCheck({ enforcing, labelFor, supabaseUrl }) {
    const dir = mkdtempSync(join(tmpdir(), 'self-host-check-'))
    const bin = join(dir, 'bin')
    writeFakeBin(bin, { enforcing, labelFor })
    const templatesDir = join(dir, 'supabase', 'templates')
    mkdirSync(templatesDir, { recursive: true })
    for (const name of TEMPLATES) writeFileSync(join(templatesDir, name), '<p>{{ .Token }}</p>\n')
    writeFileSync(join(dir, '.env'), ENV.replace('http://localhost:54421', supabaseUrl ?? 'http://localhost:54421'))

    // Async spawn, not spawnSync: the stub server lives in this process, so
    // blocking here would stop it answering the script's Supabase request.
    const child = spawn(process.execPath, [SCRIPT], {
        cwd: dir,
        // The sandbox sets proxy variables; the stub Supabase is local, so the
        // check must reach it directly instead of through the proxy.
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            NO_PROXY: 'localhost,127.0.0.1',
            no_proxy: 'localhost,127.0.0.1',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            http_proxy: '',
            https_proxy: '',
        },
        timeout: 30_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const status = await new Promise((resolve) => child.on('close', resolve))
    return { status, stdout, stderr }
}

const userHome = () => 'user_home_t'
const containerFile = () => 'container_file_t'

test('SELinux enforcing with mislabeled templates: the check fails and names the fix', async () => {
    const result = await runCheck({ enforcing: true, labelFor: userHome })
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stderr, /confirmation\.html/)
    assert.match(result.stderr, /user_home_t/)
    assert.match(result.stderr, /chcon -t container_file_t/)
    assert.match(result.stderr, /403/)
})

test('SELinux enforcing with container_file_t templates: the check passes', async () => {
    const result = await runCheck({ enforcing: true, labelFor: containerFile })
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /Supabase answers/)
})

test('SELinux disabled: the check passes without looking at labels', async () => {
    const result = await runCheck({ enforcing: false, labelFor: userHome })
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
})

test('hosted Supabase: the check passes without looking at labels', async () => {
    // 127.0.0.2 is loopback, so it reaches the stub, but it is not a
    // localhost URL, so the local-only template check must not run for it.
    const result = await runCheck({ enforcing: true, labelFor: userHome, supabaseUrl: 'http://127.0.0.2:54421' })
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
})

test('stat cannot read a label: the check passes instead of failing on its own tooling', async () => {
    const result = await runCheck({ enforcing: true, labelFor: 'fail' })
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
})

test('only one template mislabeled: the check names only that file', async () => {
    const result = await runCheck({
        enforcing: true,
        labelFor: (name) => (name === 'magic_link.html' ? 'user_home_t' : 'container_file_t'),
    })
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stderr, /magic_link\.html/)
    assert.doesNotMatch(result.stderr, /confirmation\.html/)
    assert.doesNotMatch(result.stderr, /email_change\.html/)
})
