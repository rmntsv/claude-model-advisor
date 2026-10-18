# model-advisor for Claude Code

A Claude Code plugin that checks each prompt **before the work starts** and asks you to switch when another model would do the job better or cheaper. If the current model fits, the prompt goes straight through.

- Task simpler than your model → suggests the lower tier (e.g. Opus → Sonnet/Haiku).
- Task harder than your model → suggests the higher tier.
- The prompt is held until you answer. Nothing is sent to the model first.
- Shows the recommended **effort** level too.

## Install

```
/plugin marketplace add rmntsv/claude-model-advisor
/plugin install model-advisor@claude-model-advisor
```

Restart Claude Code afterwards. Requires a Claude Code version with function-hook plugins (tested on 2.1.302).

## What happens on a prompt

1. A local scorer rates complexity and volume separately (English and Russian keyword lists, plus weak signals such as "sometimes… only under load… propose a design"). A large but routine task does not raise the model. This costs **no tokens**.
2. If no keyword matched, an optional **Haiku classifier** decides (roughly a few hundred input tokens and about 5 output tokens per ambiguous prompt; results are memoized per session).
3. Short agreements such as "yes", "go ahead", "ok" inherit the scope of the assistant's last proposal and your previous task instead of being scored as a two-letter prompt.
4. If the recommended model differs from the current one, you get a question: **Switch to X / Stay on Y**, with a cost hint (context size, cache warm or cold).
5. **Switch** sends the request on X and keeps X until the recommendation changes, so the prompt cache is rebuilt once, not twice. **Stay** runs the task unchanged. If the dialog does not show or is closed, the prompt is not sent; sending the same text again continues on the current model.

### About the prompt cache

The prompt cache is per model. Switching rebuilds it, so a switch is not free on a long, recently used conversation (cache reads cost far less than cache writes). The advisor shows the context size and cache state in the question and puts **Stay** first when a switch would be expensive. See Anthropic's [prompt caching docs](https://code.claude.com/docs/en/prompt-caching).

## Commands

`/model-advisor` with one of:

| Argument | Effect |
|---|---|
| `on` / `off` | Enable or disable the advisor |
| `classifier on` / `classifier off` | Haiku classifier for ambiguous prompts (on by default) |
| `ask on` / `ask off` | Switch question before a task (on by default) |
| `reset` | Clear the model override |
| `stats` | Counts from the local log (see Privacy) |
| *(none)* | Status |

The command is named `model-advisor` because Claude Code already has a built-in `/advisor` for a different feature.

## Accuracy: what is and is not known

`hooks/prompts.ts` holds 63 labelled prompts (English and Russian). On that set the scorer picks the labelled model for 57 of 63, under-estimates 4 and over-estimates 2. The labels and many of the later keyword signals were written by the same author, so **treat these numbers as optimistic, not as expected accuracy on your work**. On 20 ambiguous prompts the Haiku classifier agreed with the labels on 14. Under-estimation (a hard task sent to a weaker model) is the main risk. Run `claude plugin test plugins/model-advisor` to reproduce, and add your own labelled prompts to `prompts.ts`.

## Limits

- A switch is applied to main-thread requests; the app UI keeps showing the original model. The status line shows the active one. The plugin cannot run `/model` for you.
- Model ids are derived by swapping the family word in the session's model id, which assumes ids shaped like `claude-<family>-<version>`.
- Subagent requests are not changed.
- Heuristic keyword rules cannot understand a prompt; ambiguous cases rely on the classifier.

## Privacy

- The scorer runs locally.
- The optional classifier sends the prompt text (first 1,500 characters) to Haiku through your own session credentials, like any other request. Turn it off with `/model-advisor classifier off`.
- A local log (`stats`) keeps only metadata per prompt: length, recommended and current model family, flags. No prompt text is stored. The classifier memo keeps prompt text in memory for the session only.
- No data is sent anywhere else.

## Related projects

I have not audited the code of the projects below; descriptions come from their public listings and Anthropic's docs.

- Anthropic's built-in [advisor tool](https://code.claude.com/docs/en/advisor): a cheaper main model consults a stronger model at decision points. Different idea: it escalates *within* a task rather than picking a model per prompt.
- [`opusplan`](https://code.claude.com/docs/en/model-config) and subagent `model:` settings: built-in ways to use a stronger model for planning and a cheaper one for execution.
- [Claude-Code-Opus-Sonnet-Routing (CharlesLam0)](https://github.com/CharlesLam0/Claude-Code-Opus-Sonnet-Routing): a prompt hook that recommends Sonnet or Opus by complexity (per its description, with confirmation before switching).
- [claude-code-router (musistudio)](https://github.com/musistudio/claude-code-router): a local proxy that routes Claude Code requests to other model providers; a different problem (provider routing, not Claude tier choice).

What this plugin adds, as far as I can tell: it holds the prompt until you answer, accounts for prompt-cache cost in the question, keeps the choice sticky instead of hopping back, and handles "yes, go ahead" replies.

## Development

```
claude plugin validate plugins/model-advisor
claude plugin test plugins/model-advisor
```

## License

MIT
