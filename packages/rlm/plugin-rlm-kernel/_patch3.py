# -*- coding: utf-8 -*-
"""One-shot patch: Phase B delegation-boundary escort in kernel host-handlers."""
import io

p = 'packages/rlm/plugin-rlm-kernel/src/host-handlers.ts'
s = io.open(p, encoding='utf-8').read()
n = 0

# Insert the delegation-boundary escort right after sid resolution in rlm.run.
old = """      const sid = String(parent.session.id)

      // Resource governors: an unbounded prompt inflates a child's context
      // silently, and an unchecked fan-out lets a looping model create
      // unlimited concurrent LLM-burning children. Both fail loud with"""
new = """      const sid = String(parent.session.id)

      // Phase B trigger ① (delegation boundary, down): the boundary is a
      // first-class action-boundary event, and the parent's freshness is
      // re-checked before the child runs on its premises. Stale beliefs do
      // not block the delegation (the lock is on the gate, not the engine) —
      // they surface as a warning the manager must carry.
      const storeAtBoundary = ctx.get('rlm.store')
      let freshnessWarning = ''
      if (storeAtBoundary) {
        const scope = { kind: 'session' as const, id: sid }
        await storeAtBoundary.append(scope, 'rlm/action-boundary', {
          action: 'delegation-down',
          child: name,
          promptChars: prompt.length,
        })
        const stale = storeAtBoundary.evaluateFreshness(scope).filter(v => v.stale)
        if (stale.length > 0) {
          freshnessWarning = `[freshness] ${stale.length} belief(s) went stale on the delegation boundary `
            + `(external checkpoints moved or the internal clock ran out) — re-verify before building on them. `
            + `Beliefs: ${stale.map(v => v.beliefId).join(', ')}. `
            + 'Run enforceFreshness via /harness review or re-read the touched objects.'
        }
      }

      // Resource governors: an unbounded prompt inflates a child's context
      // silently, and an unchecked fan-out lets a looping model create
      // unlimited concurrent LLM-burning children. Both fail loud with"""
assert old in s, 1
s = s.replace(old, new); n += 1

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print(f'applied: {n} edits')
