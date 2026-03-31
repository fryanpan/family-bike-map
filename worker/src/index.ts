/**
 * Cloudflare Worker for Berlin Bike Route Finder
 *
 * Routes:
 *   /valhalla/*   → CORS proxy to valhalla1.openstreetmap.de
 *   /nominatim/*  → CORS proxy to nominatim.openstreetmap.org
 *   POST /feedback → create a Linear issue from user feedback
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Env = {
  LINEAR_API_KEY?: string
  LINEAR_TEAM_ID?: string
  LINEAR_PROJECT_ID?: string
  LINEAR_ASSIGNEE_ID?: string
}

const app = new Hono<{ Bindings: Env }>()

// Allow CORS from surge.sh and localhost
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*'
    if (
      origin.endsWith('.surge.sh') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) {
      return origin
    }
    return null
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// ── Valhalla proxy ──────────────────────────────────────────────────────────

app.all('/valhalla/*', async (c) => {
  const path = c.req.path.replace(/^\/valhalla/, '')
  const url = `https://valhalla1.openstreetmap.de${path}${c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''}`

  const body = c.req.method !== 'GET' ? await c.req.arrayBuffer() : undefined

  const upstream = await fetch(url, {
    method: c.req.method,
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  const data = await upstream.arrayBuffer()
  return new Response(data, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
  })
})

// ── Nominatim proxy ─────────────────────────────────────────────────────────

app.all('/nominatim/*', async (c) => {
  const path = c.req.path.replace(/^\/nominatim/, '')
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : ''
  const url = `https://nominatim.openstreetmap.org${path}${qs}`

  const upstream = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'BerlinBikeRouteFinder/0.1 (github.com/fryanpan/bike-route-finder)',
      'Accept': 'application/json',
    },
  })

  const data = await upstream.arrayBuffer()
  return new Response(data, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
  })
})

// ── Feedback → Linear ───────────────────────────────────────────────────────

app.post('/feedback', async (c) => {
  const apiKey = c.env.LINEAR_API_KEY
  const teamId = c.env.LINEAR_TEAM_ID
  const projectId = c.env.LINEAR_PROJECT_ID
  const assigneeId = c.env.LINEAR_ASSIGNEE_ID

  if (!apiKey || !teamId || !projectId) {
    console.error('[Feedback] Linear env vars not configured')
    return c.json({ error: 'Feedback service not configured' }, 500)
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { author, text, annotations, pageUrl } = body

  const hasText = typeof text === 'string' && text.trim().length > 0
  const hasAnnotations = Array.isArray(annotations) && annotations.length > 0
  if (!hasText && !hasAnnotations) {
    return c.json({ error: 'Feedback must include text or annotations' }, 400)
  }

  // Build Linear ticket description
  let description = ''
  if (typeof text === 'string' && text.trim()) {
    description += text.trim() + '\n\n'
  }
  if (hasAnnotations) {
    description += '## Annotations\n\n'
    ;(annotations as Array<{ id: number; selector?: string; text: string }>).forEach((ann) => {
      description += `**${ann.id}.** ${ann.selector ? `\`${ann.selector}\`` : ''}\n${ann.text}\n\n`
    })
  }
  if (typeof pageUrl === 'string') {
    description += `\n**Page:** ${pageUrl}\n`
  }
  description += `\n**Submitted by:** ${typeof author === 'string' ? author : 'Anonymous'}`

  const title =
    typeof text === 'string' && text.trim()
      ? text.trim().split('\n')[0].substring(0, 80)
      : 'Feedback from Bike Route Finder'

  try {
    const resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({
        query: `
          mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier url }
            }
          }
        `,
        variables: {
          input: {
            title,
            description,
            teamId,
            projectId,
            ...(assigneeId ? { assigneeId } : {}),
          },
        },
      }),
    })

    if (!resp.ok) {
      const err = await resp.text()
      console.error('[Feedback] Linear error:', resp.status, err)
      return c.json({ error: 'Failed to create Linear ticket' }, 500)
    }

    const result = await resp.json() as {
      data?: { issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } } }
      errors?: Array<{ message: string }>
    }

    if (result.errors || !result.data?.issueCreate.success) {
      console.error('[Feedback] Linear mutation failed:', result.errors)
      return c.json({ error: 'Failed to create Linear ticket' }, 500)
    }

    const issue = result.data.issueCreate.issue!
    return c.json({ id: issue.id, identifier: issue.identifier, url: issue.url, status: 'created' }, 201)
  } catch (err) {
    console.error('[Feedback] Error:', err)
    return c.json({ error: 'Failed to create Linear ticket' }, 500)
  }
})

export default app
