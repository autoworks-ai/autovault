import { z } from "zod";

const capabilitiesSchema = z
  .object({
    network: z.boolean().optional(),
    filesystem: z.enum(["readonly", "readwrite"]).optional(),
    tools: z.array(z.string()).optional()
  })
  .optional();

const resourceSchema = z
  .array(
    z.object({
      path: z.string().min(1),
      type: z.string().optional()
    })
  )
  .optional();

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Reject ASCII C0 controls (0x00–0x1F) and DEL (0x7F) anywhere in `bin.command`
// or `bin.args[]`. These bytes survive YAML parsing and the manifest signature,
// then surface in two places: (a) the spawned process's argv, and (b) the
// `autovault skill which` review output the user inspects before running. A
// signed-but-malicious skill could embed `\n`, `\r`, or ANSI escape bytes in
// args so `which` displays a misleading command (newline shifts the displayed
// line; ESC sequences clear the screen or rewrite previous output) while
// `runAction` passes the exact hidden vector to spawn(). The user's pre-exec
// review is the gate of last resort for legitimately-shaped commands; control
// chars in argv break that gate visually. Keep the rule tight: argv elements
// are filenames, flag names, and short string values, none of which need
// control bytes. Tab (0x09) is also blocked — it renders as variable-width
// whitespace and would similarly distort columnar review output.
const NO_CONTROL_CHARS = /^[^\x00-\x1F\x7F]*$/;

// Agent names land in path.join(profileRoot, agent) inside syncProfiles. Without
// a strict pattern, frontmatter like agents: ["../../.ssh"] turns install_skill
// into a symlink-anywhere primitive relative to the storage root. Constrain to
// the same shape real agent slugs use today (claude-code, codex, autojack):
// lowercase alphanumeric + hyphen, must start with a letter. No `.`, no `/`,
// no `\`, no `..`. The schema gate is layer one; syncProfiles also runs a
// path-resolve check as defense-in-depth.
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const binActionSchema = z.object({
  command: z
    .string()
    .min(1)
    .regex(NO_CONTROL_CHARS, "command must not contain control characters (0x00-0x1F or 0x7F)"),
  args: z
    .array(
      z
        .string()
        .regex(
          NO_CONTROL_CHARS,
          "args must not contain control characters (0x00-0x1F or 0x7F)"
        )
    )
    .optional(),
  description: z.string().optional(),
  "requires-tty": z.boolean().optional()
});

const binSchema = z
  .record(z.string(), binActionSchema)
  .superRefine((value, ctx) => {
    for (const action of Object.keys(value)) {
      if (!ACTION_NAME_PATTERN.test(action)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [action],
          message: `bin action name "${action}" must match ${ACTION_NAME_PATTERN}`
        });
      }
    }
  })
  .optional();

const schema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, "must be alphanumeric with - or _"),
  title: z.string().min(1).optional(),
  description: z.string().min(20),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  agents: z
    .array(
      z
        .string()
        .min(1)
        .regex(AGENT_NAME_PATTERN, "agent name must match ^[a-z][a-z0-9-]*$")
    )
    .min(1, "at least one agent is required"),
  category: z.string().optional(),
  when_to_use: z.string().min(1).optional(),
  when_not_to_use: z.string().min(1).optional(),
  risk_level: z.string().min(1).optional(),
  metadata: z
    .object({
      version: z.string().default("1.0.0")
    })
    .optional(),
  capabilities: capabilitiesSchema,
  resources: resourceSchema,
  bin: binSchema,
  "requires-secrets": z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        required: z.boolean().optional()
      })
    )
    .optional()
});

export function validateSchema(data: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  };
}
