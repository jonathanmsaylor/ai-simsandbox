export default function Page() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
          aria-hidden="true"
        >
          <span className="size-2 rounded-full bg-green-500" />
          Online
        </span>
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          AI Sandbox Dialogue Backend — Online
        </h1>
        <p className="max-w-md text-pretty text-sm text-muted-foreground">
          POST JSON to <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">/api/dialogue</code> to
          generate an in-character NPC reply.
        </p>
      </div>
    </main>
  )
}
