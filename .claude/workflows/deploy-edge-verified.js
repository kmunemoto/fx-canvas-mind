export const meta = {
  name: 'deploy-edge-verified',
  description: 'Deploy one Supabase edge function from its local bundle.js and verify the deployed file byte-for-byte (sha256), retrying on drift',
  whenToUse: 'Whenever an edge function bundle under supabase/functions/<slug>/bundle.js must go live. args: { slug, version, project? }',
  phases: [{ title: 'Deploy' }, { title: 'Verify' }],
}

// The bundle is emitted through a model's output on its way to the deploy
// tool, and a model can drift while transcribing 25-70 KB of minified code —
// it has, in this project, more than once. So the deployed file is read back
// and hashed against the local one, and a mismatch redeploys, up to three
// times. Nothing is declared live on the strength of the deploy call alone.
const slug = args?.slug
const version = args?.version
const project = args?.project ?? 'endcqzewujdvimdlazhj'
if (!slug || !version) throw new Error('args.slug and args.version are required')
const LOCAL = `/home/user/fx-canvas-mind/supabase/functions/${slug}/bundle.js`

const VERDICT = {
  type: 'object',
  required: ['identical', 'deployed_sha256', 'local_sha256', 'deployed_bytes', 'local_bytes', 'version_string', 'function_version'],
  properties: {
    identical: { type: 'boolean' },
    deployed_sha256: { type: 'string' },
    local_sha256: { type: 'string' },
    deployed_bytes: { type: 'number' },
    local_bytes: { type: 'number' },
    version_string: { type: 'string' },
    function_version: { type: 'number' },
    diff_head: { type: 'string' },
  },
}

let attempts = 0
let verdict = null
while (attempts < 3) {
  attempts++
  phase('Deploy')
  log(`${slug}: deploy attempt ${attempts}`)
  const dep = await agent(`Deploy the Supabase edge function "${slug}" in project ${project} with EXACTLY the content of the local file ${LOCAL}.

The file is one very long minified line. Read it completely with the Read tool — it is paged: call Read with offset/limit repeatedly until you have seen every line (the tool reports the total line count and how to page). Do not summarise or abbreviate anything.

Then use ToolSearch to load mcp__Supabase__deploy_edge_function and call it ONCE with:
- project_id: "${project}"
- name: "${slug}"
- entrypoint_path: "bundle.js"
- import_map_path: "deno.json"
- verify_jwt: false
- files: [ { name: "deno.json", content: "{\\n  \\"imports\\": {}\\n}\\n" }, { name: "bundle.js", content: <the file content, VERBATIM, every character, ending with the file's trailing newline> } ]

Rules: the bundle content must be transcribed character for character from what Read showed you — no placeholders, no "...", no reformatting, no added or removed whitespace, non-ASCII strings kept as they are. It contains the string "${version}"; make sure your content contains it too. If the tool call fails, report the error verbatim; do not retry with modified content.

Return the tool result JSON (id, version, ezbr_sha256, status) verbatim, or the error.`, { label: `deploy#${attempts}`, phase: 'Deploy', effort: 'high' })
  log(`deploy result: ${String(dep).slice(0, 160)}`)

  phase('Verify')
  verdict = await agent(`Verify that the Supabase edge function "${slug}" in project ${project} is deployed with EXACTLY the local file ${LOCAL}.

1. ToolSearch-load mcp__Supabase__get_edge_function; call it with project_id "${project}", function_slug "${slug}". Take files[] entry named "bundle.js".
2. Write that content VERBATIM to /tmp/deployed-${slug}.js with the Write tool (overwrite; do not abbreviate).
3. Run: sha256sum /tmp/deployed-${slug}.js ${LOCAL}; wc -c /tmp/deployed-${slug}.js ${LOCAL}; diff <(fold -w 200 /tmp/deployed-${slug}.js) <(fold -w 200 ${LOCAL}) | head -20; grep -o '${slug}-v[0-9]*-[0-9T:.Z-]*' /tmp/deployed-${slug}.js | head -1
4. Report the two sha256 sums, byte counts, whether identical, the diff head if not, the version string found, and the function "version" number from the tool result. Do not modify any file under /home/user/fx-canvas-mind.`, { label: `verify#${attempts}`, phase: 'Verify', effort: 'medium', schema: VERDICT })
  log(`verify: identical=${verdict?.identical} deployed=${verdict?.deployed_bytes}B local=${verdict?.local_bytes}B fn v${verdict?.function_version}`)
  if (verdict && verdict.identical && verdict.version_string === version) break
}
if (!verdict || !verdict.identical) log(`${slug}: NOT verified after ${attempts} attempts — do not treat as live`)
return { slug, attempts, verdict }
