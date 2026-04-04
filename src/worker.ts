/**
 * Unified Cloudflare Worker for Berlin Bike Route Finder
 *
 * Handles API routes (Valhalla proxy, Nominatim proxy, feedback → Linear).
 * Static assets are served automatically by the [assets] binding for non-API paths.
 *
 * Routes:
 *   /api/valhalla/*   → proxy to valhalla1.openstreetmap.de
 *   /api/nominatim/*  → proxy to nominatim.openstreetmap.org
 *   POST /api/feedback → create a Linear issue from user feedback
 */

type Env = {
  LINEAR_API_KEY?: string
  LINEAR_TEAM_ID?: string
  LINEAR_PROJECT_ID?: string
  LINEAR_ASSIGNEE_ID?: string
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // ── Valhalla proxy ────────────────────────────────────────────────
    if (path.startsWith('/api/valhalla/')) {
      const upstream = path.replace(/^\/api\/valhalla/, '')
      const target = `https://valhalla1.openstreetmap.de${upstream}${url.search}`

      const body = request.method !== 'GET' ? await request.arrayBuffer() : undefined

      const resp = await fetch(target, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body,
      })

      return new Response(await resp.arrayBuffer(), {
        status: resp.status,
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
      })
    }

    // ── Overpass proxy with Cloudflare edge cache ─────────────────────
    // Proxying through the Worker (same-origin) avoids iOS content blockers
    // that block direct requests to overpass-api.de (a third-party domain).
    //
    // The Overpass API usage policy asks public-facing apps to avoid hitting
    // the public API on every user request. We comply by caching tile responses
    // at the Cloudflare edge (shared across ALL users, global) for 7 days.
    // First visitor pays the Overpass cost; everyone else gets the cached response.
    //
    // ?row=&col=&profile= query params identify the tile for the cache key.
    if (path === '/api/overpass') {
      const row = url.searchParams.get('row') ?? ''
      const col = url.searchParams.get('col') ?? ''
      const profile = url.searchParams.get('profile') ?? ''

      // Synthetic GET URL used as Cloudflare cache key (POST responses aren't cacheable).
      const cacheKey = new Request(
        `https://overpass-tile-cache.internal/v1/${row}/${col}/${encodeURIComponent(profile)}`,
      )

      const cached = await caches.default.match(cacheKey)
      if (cached) {
        return new Response(cached.body, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
          },
        })
      }

      const body = await request.arrayBuffer()
      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'BerlinBikeRouteFinder/0.1 (github.com/fryanpan/bike-route-finder)',
        },
        body,
      })

      const respBody = await resp.arrayBuffer()

      // Only cache successful responses. Non-200 (429, 504) should not be cached
      // so the client can retry against a fresh Overpass response later.
      if (resp.ok) {
        const toCache = new Response(respBody, {
          headers: {
            'Content-Type': 'application/json',
            // 7-day TTL: long enough to be useful, short enough for OSM edits to appear.
            'Cache-Control': 'public, max-age=604800',
          },
        })
        await caches.default.put(cacheKey, toCache)
      }

      return new Response(respBody, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
          'X-Cache': 'MISS',
        },
      })
    }

    // ── Nominatim proxy ───────────────────────────────────────────────
    if (path.startsWith('/api/nominatim/')) {
      const upstream = path.replace(/^\/api\/nominatim/, '')
      const target = `https://nominatim.openstreetmap.org${upstream}${url.search}`

      const resp = await fetch(target, {
        method: 'GET',
        headers: {
          'User-Agent': 'BerlinBikeRouteFinder/0.1 (github.com/fryanpan/bike-route-finder)',
          'Accept': 'application/json',
        },
      })

      return new Response(await resp.arrayBuffer(), {
        status: resp.status,
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
      })
    }

    // ── Feedback → Linear ─────────────────────────────────────────────
    if (path === '/api/feedback' && request.method === 'POST') {
      return handleFeedback(request, env)
    }

    // ── All other paths: serve static assets via [assets] binding ─────
    return env.ASSETS.fetch(request)
  },
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const apiKey = env.LINEAR_API_KEY
  const teamId = env.LINEAR_TEAM_ID
  const projectId = env.LINEAR_PROJECT_ID
  const assigneeId = env.LINEAR_ASSIGNEE_ID

  if (!apiKey || !teamId || !projectId) {
    console.error('[Feedback] Linear env vars not configured')
    return Response.json({ error: 'Feedback service not configured' }, { status: 500 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { author, text, annotations, pageUrl } = body

  const hasText = typeof text === 'string' && text.trim().length > 0
  const hasAnnotations = Array.isArray(annotations) && annotations.length > 0
  if (!hasText && !hasAnnotations) {
    return Response.json({ error: 'Feedback must include text or annotations' }, { status: 400 })
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
      return Response.json({ error: 'Failed to create Linear ticket' }, { status: 500 })
    }

    const result = (await resp.json()) as {
      data?: {
        issueCreate: {
          success: boolean
          issue?: { id: string; identifier: string; url: string }
        }
      }
      errors?: Array<{ message: string }>
    }

    if (result.errors || !result.data?.issueCreate.success) {
      console.error('[Feedback] Linear mutation failed:', result.errors)
      return Response.json({ error: 'Failed to create Linear ticket' }, { status: 500 })
    }

    const issue = result.data.issueCreate.issue!
    return Response.json(
      { id: issue.id, identifier: issue.identifier, url: issue.url, status: 'created' },
      { status: 201 },
    )
  } catch (err) {
    console.error('[Feedback] Error:', err)
    return Response.json({ error: 'Failed to create Linear ticket' }, { status: 500 })
  }
}
