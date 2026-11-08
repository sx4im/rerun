// Tests for scripts/self-host-check.mjs. Run with:
//   node --test scripts/self-host-check.test.mjs
// (or `pnpm test` from the repository root)
//
// Each test runs the real script in a fresh temp directory, against a stub Supabase
// (a tiny HTTP server on 127.0.0.1:54421 answering the check_email_exists RPC) and a
// fake `docker` on PATH, so no Supabase stack or Docker is needed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'self-host-check.mjs')
const PORT = 54421

let server = null
let portBusy = false
before(async () => {
    server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/rest/v1/rpc/check_email_exists') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{}')
            return
        }
        res.writeHead(404)
        res.end()
    })
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(PORT, '127.0.0.1', resolve)
        })
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            portBusy = true
            return
        }
        throw error
    }
})
after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())))

function skipIfBusy(t) {
    if (!portBusy) return false
    t.skip('port 54421 is in use — a local Supabase is running')
    return true
}

function runCheck({ dockerMode }) {
    const dir = mkdtempSync(join(tmpdir(), 'self-host-check-'))
    writeFileSync(join(dir, '.env'), [
        'NEXT_PUBLIC_APP_URL=http://localhost:3000',
        'NEXT_PUBLIC_SUPABASE_URL=http://localhost:54421',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test',
        'SUPABASE_SECRET_KEY=sb_secret_test',
        'RERUN_ENGINE_API_KEY=',
        'FOREMAN_HUB_TOKEN_SECRET=',
        'BOARD_IMAGE_SECRET=',
        '',
    ].join('\n'))
    let path = process.env.PATH ?? ''
    if (dockerMode !== 'absent') {
        const bin = join(dir, 'bin')
        mkdirSync(bin)
        writeFileSync(join(bin, 'docker'), `#!/bin/sh
# Fake docker: answers the Kong lookup, then the per-template readability probe.
if [ "$1" = "ps" ]; then
  echo "supabase_kong_rerun"
  exit 0
fi
# docker exec <container> test -r <path>
if [ "$DOCKER_TEMPLATE_MODE" = "unreadable" ]; then exit 1; fi
exit 0
`)
        chmodSync(join(bin, 'docker'), 0o755)
        path = `${bin}:${path}`
    } else {
        path = dir // nothing called docker on PATH
    }
    // Async spawn: the stub Supabase server lives in this process, so the child must
    // run without blocking this event loop.
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SCRIPT], {
            cwd: dir,
            env: { ...process.env, PATH: path, DOCKER_TEMPLATE_MODE: dockerMode },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        const guard = setTimeout(() => child.kill(), 30_000)
        guard.unref()
        child.on('close', (status) => {
            clearTimeout(guard)
            rmSync(dir, { recursive: true, force: true })
            resolve({ status, stdout, stderr })
        })
    })
}

test('fails when Kong cannot read the email templates', async (t) => {
    if (skipIfBusy(t)) return
    const { status, stderr } = await runCheck({ dockerMode: 'unreadable' })
    assert.equal(status, 1)
    assert.match(stderr, /Kong cannot read/)
    assert.match(stderr, /email_change\.html/)
    assert.match(stderr, /chcon -t container_file_t/)
})

test('passes when Kong can read the email templates', async (t) => {
    if (skipIfBusy(t)) return
    const { status, stdout } = await runCheck({ dockerMode: 'readable' })
    assert.equal(status, 0)
    assert.match(stdout, /\.env is ready/)
})

test('passes when there is no Docker to ask', async (t) => {
    if (skipIfBusy(t)) return
    const { status, stdout } = await runCheck({ dockerMode: 'absent' })
    assert.equal(status, 0)
    assert.match(stdout, /\.env is ready/)
})
