import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-proposal-repo-'))
process.env.RERUN_DATA_DIR = dataDir

const { describe, expect, it } = await import('vitest')
const { insertSkillProposal, findSkillProposalByFingerprint, transitionSkillProposal, getSkillProposal, openSkillProposalForSession } = await import('./skill-proposals.js')

const id = 'repo-agent'

let seq = 0
async function proposal() {
    seq += 1
    return insertSkillProposal(id, {
        sessionId: `session-${seq}`,
        runId: null,
        toolCallId: `call-${seq}`,
        mode: 'create',
        slug: null,
        title: 'Publishing checklist',
        summary: 'Always end a post with a CTA',
        instruction: 'Every post ends with a call to action.',
        fingerprint: `fp-${seq}`,
    })
}

describe('transitionSkillProposal', () => {
    it('lets exactly one of two concurrent clicks through', async () => {
        const row = await proposal()
        const [first, second] = await Promise.all([
            transitionSkillProposal(id, row.id, ['proposed'], 'accepted'),
            transitionSkillProposal(id, row.id, ['proposed'], 'accepted'),
        ])
        expect([first, second].filter(Boolean)).toHaveLength(1)
        expect((await getSkillProposal(id, row.id))?.status).toBe('accepted')
    })

    it('refuses a transition from a status that already moved on', async () => {
        const row = await proposal()
        await transitionSkillProposal(id, row.id, ['proposed'], 'dismissed')
        expect(await transitionSkillProposal(id, row.id, ['proposed'], 'accepted')).toBe(false)
    })

    it('takes a decided proposal out of the way of the next one', async () => {
        const row = await proposal()
        expect((await openSkillProposalForSession(id, row.sessionId))?.id).toBe(row.id)
        await transitionSkillProposal(id, row.id, ['proposed'], 'dismissed')
        expect(await openSkillProposalForSession(id, row.sessionId)).toBeUndefined()
    })
})

describe('findSkillProposalByFingerprint', () => {
    it('ignores a failed proposal so the same rule can be raised again', async () => {
        const row = await proposal()
        expect((await findSkillProposalByFingerprint(id, `fp-${seq}`))?.id).toBe(row.id)
        await transitionSkillProposal(id, row.id, ['proposed'], 'accepted')
        await transitionSkillProposal(id, row.id, ['accepted'], 'failed', { error: 'No object generated' })
        expect(await findSkillProposalByFingerprint(id, `fp-${seq}`)).toBeUndefined()
    })

    it('still tombstones a dismissed proposal', async () => {
        const row = await proposal()
        await transitionSkillProposal(id, row.id, ['proposed'], 'dismissed')
        expect((await findSkillProposalByFingerprint(id, `fp-${seq}`))?.id).toBe(row.id)
    })

    it('still finds a proposal that is waiting for a decision', async () => {
        const row = await proposal()
        expect((await findSkillProposalByFingerprint(id, `fp-${seq}`))?.id).toBe(row.id)
    })
})
