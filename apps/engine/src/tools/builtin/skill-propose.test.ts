import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-skill-propose-'))
process.env.RERUN_DATA_DIR = dataDir

const { describe, expect, it, beforeAll } = await import('vitest')
const { z } = await import('zod')
const { skillProposeTool, proposalFingerprint } = await import('./skill-propose.js')
const { isHitlToolName, lastStepHasHitlCall } = await import('./hitl.js')
const { writeSkill } = await import('../../skills/loader.js')
const { skillsDir } = await import('../../config/paths.js')
const { listSessionSkillProposals, transitionSkillProposal } = await import('../../db/repos/skill-proposals.js')
const { getSystemDb } = await import('../../db/systemDb.js')
const { skillProposalInputSchema } = await import('@rerun/contracts')

const id = 'proposer'
const announced: Array<{ proposalId: string; mode: string; title: string }> = []
function runOn(sessionId: string, connectionId: string, provider: string, model: string, { skillProposals = announced } = {}) {
    return skillProposeTool({ agent: { id, resolved: { connection: { id: connectionId }, provider, model } }, sessionId, provider, model, skillProposals } as any)
}

const tools = runOn('session-1', 'claude-sub', 'claude', 'claude-opus-5-5')
const otherSession = runOn('session-2', 'claude-sub', 'claude', 'claude-opus-5-5')

let callId = 0
async function propose(tool: typeof tools, args: Record<string, unknown>): Promise<string> {
    callId += 1
    return (await (tool.skill_propose as any).execute(args, { toolCallId: `call-${callId}` })) as string
}

function parse(result: string): { status?: string; proposalId?: string; message?: string } {
    try {
        return JSON.parse(result)
    } catch {
        return { message: result }
    }
}

const rule = { mode: 'create', slug: null, title: 'Publishing checklist', summary: 'Always end a post with a CTA', instruction: 'Every published post ends with a call to action.' }

beforeAll(async () => {
    await writeSkill(id, 'Publishing', 'How posts go out', 'Draft, review, publish.')
})

describe('the non-blocking contract', () => {
    it('is not a human-in-the-loop tool', () => {
        expect(isHitlToolName('skill_propose')).toBe(false)
        expect(lastStepHasHitlCall([{ toolCalls: [{ toolName: 'skill_propose' }] }])).toBe(false)
    })

    it('takes a whole flow in a single instruction', () => {
        expect(skillProposalInputSchema.safeParse({ ...rule, instruction: 'x'.repeat(3000) }).success).toBe(true)
    })

    it('requires every input key, as strict structured output needs', () => {
        const schema = z.toJSONSchema(skillProposalInputSchema) as { properties?: Record<string, unknown>; required?: string[] }
        expect(schema.required).toEqual(Object.keys(schema.properties ?? {}))
    })
})

describe('skill_propose', () => {
    it('shows a proposal and writes no skill', async () => {
        const before = readdirSync(skillsDir(id)).length
        const result = parse(await propose(tools, rule))
        expect(result.status).toBe('shown')
        expect(result.message).toContain('Proposal shown to the user')
        expect(readdirSync(skillsDir(id)).length).toBe(before)
        const rows = await listSessionSkillProposals(id, 'session-1')
        expect(rows).toHaveLength(1)
        expect(result.proposalId).toBe(rows[0].id)
        expect(JSON.parse(rows[0].instructionsJson)).toEqual([rule.instruction])
        expect(rows[0]).toMatchObject({ connectionId: 'claude-sub', provider: 'claude', model: 'claude-opus-5-5' })
        expect(announced).toEqual([{ proposalId: rows[0].id, mode: 'create', title: rows[0].title }])
    })

    // One ack whatever the model wrote before: a proposal is mentioned in the message, never a
    // reason to write that message a second time.
    it('asks for one sentence in the message and nothing else', async () => {
        const fresh = runOn('session-written', 'claude-sub', 'claude', 'claude-opus-5-5', { skillProposals: [] })
        const result = parse(await propose(fresh, { ...rule, title: 'Written first', instruction: 'Every report opens with the numbers.' }))
        expect(result.message).toContain('In your message, tell them in one short sentence')
        expect(result.message).not.toContain('do not write it again')
    })

    it('folds a second rule into the proposal already waiting', async () => {
        const switchedToCodex = runOn('session-1', 'codex-sub', 'codex', 'gpt-5.5')
        const result = parse(await propose(switchedToCodex, { ...rule, instruction: 'Posts stay under 900 characters.', summary: 'Two rules for posts' }))
        expect(result.status).toBe('merged')
        expect(result.message).toContain('Added to the proposal already waiting')
        const rows = await listSessionSkillProposals(id, 'session-1')
        expect(rows).toHaveLength(1)
        expect(result.proposalId).toBe(rows[0].id)
        expect(JSON.parse(rows[0].instructionsJson)).toHaveLength(2)
        expect(rows[0].summary).toBe('Two rules for posts')
        expect(rows[0]).toMatchObject({ connectionId: 'codex-sub', provider: 'codex', model: 'gpt-5.5' })
        expect(announced).toHaveLength(2)
        expect(announced[1].proposalId).toBe(rows[0].id)
    })

    it('refuses an edit aimed at a skill that does not exist', async () => {
        const result = await propose(otherSession, { ...rule, mode: 'edit', slug: 'nope' })
        expect(result).toContain('No skill with slug "nope"')
        expect(await listSessionSkillProposals(id, 'session-2')).toHaveLength(0)
    })

    it('never proposes the same rule twice, in any conversation or any state', async () => {
        const rows = await listSessionSkillProposals(id, 'session-1')
        await transitionSkillProposal(id, rows[0].id, ['proposed'], 'dismissed')

        expect(await propose(otherSession, rule)).toContain('Already proposed once')
        expect(await propose(otherSession, { ...rule, instruction: 'Posts stay under 900 characters.' })).toContain('Already proposed once')
        expect(await listSessionSkillProposals(id, 'session-2')).toHaveLength(0)
        expect(announced).toHaveLength(2)
    })

    it('lets a failed proposal be raised again', async () => {
        const failedRule = { ...rule, title: 'Failed checklist', instruction: 'Every draft is spellchecked before it goes out.' }
        const first = parse(await propose(otherSession, failedRule))
        expect(first.status).toBe('shown')
        const rows = await listSessionSkillProposals(id, 'session-2')
        expect(rows).toHaveLength(1)
        await transitionSkillProposal(id, rows[0].id, ['proposed'], 'failed')

        const second = parse(await propose(otherSession, failedRule))
        expect(second.status).toBe('shown')
        expect(second.proposalId).not.toBe(first.proposalId)
    })

    it('saves proposals whose bridge request ids repeat across runs', async () => {
        const firstRun = runOn('session-run-1', 'claude-sub', 'claude', 'claude-opus-5-5', { skillProposals: [] })
        const secondRun = runOn('session-run-2', 'claude-sub', 'claude', 'claude-opus-5-5', { skillProposals: [] })
        const execute = (tool: typeof tools, instruction: string) => (tool.skill_propose as any).execute({ ...rule, instruction }, { toolCallId: '7' }) as Promise<string>

        const first = parse(await execute(firstRun, 'Every invoice is checked twice before it goes out.'))
        const second = parse(await execute(secondRun, 'Every quote names the person who approved it.'))

        expect(first.status).toBe('shown')
        expect(second.status).toBe('shown')
        expect(first.proposalId).not.toBe(second.proposalId)
    })

    it('answers in plain words when the proposal cannot be saved', async () => {
        const broken = 'proposer-broken-db'
        const { client } = await getSystemDb(broken)
        await client.execute('DROP TABLE skill_proposals')
        const tool = skillProposeTool({ agent: { id: broken, resolved: { connection: null } }, sessionId: 'session-1', provider: 'claude', model: 'claude-opus-5-5', skillProposals: [] } as any)

        const result = await (tool.skill_propose as any).execute(rule, { toolCallId: 'call-broken' })

        expect(result).toBe('Could not save the proposal. Nothing shown. Do not retry.')
    })
})

describe('proposalFingerprint', () => {
    it('ignores punctuation, case and spacing of the same rule', () => {
        const a = proposalFingerprint({ mode: 'edit', slug: 'publishing', title: 'Publishing', instruction: 'Every post ends with a CTA.' })
        const b = proposalFingerprint({ mode: 'edit', slug: 'publishing', title: 'Publishing', instruction: '  every   post ends with a cta  ' })
        expect(a).toBe(b)
    })

    it('separates the same rule aimed at two different skills', () => {
        const a = proposalFingerprint({ mode: 'edit', slug: 'publishing', title: 'Publishing', instruction: 'Every post ends with a CTA.' })
        const b = proposalFingerprint({ mode: 'edit', slug: 'newsletter', title: 'Newsletter', instruction: 'Every post ends with a CTA.' })
        expect(a).not.toBe(b)
    })
})
