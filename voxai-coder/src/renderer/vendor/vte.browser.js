"use strict";
var VTEBundle = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/browser.ts
  var browser_exports = {};
  __export(browser_exports, {
    process: () => process,
    processStream: () => processStream,
    reveal: () => reveal
  });

  // ../../spec/markers.json
  var markers_default = {
    $schema_version: "1.0.0",
    description: "Authoritative leaked-marker registry for the Vox Text Engine. Executed identically by the Python and TypeScript cores. Patterns use a PORTABLE regex subset (no inline flags, no named groups, no backreferences) so Python `re` and JS `RegExp` behave the same. `flags` letters map to re.I/M/S and JS i/m/s (JS also always adds `g`). `scope`: inline=strip anywhere, line=whole matching line, block=paired open/close span. `stream_risk`: true means the marker can appear mid-answer and MUST be held back by the stream scrubber so it never flashes. `open` is the literal opening lead used by the stream scrubber's hold-back detection.",
    markers: [
      {
        id: "vox_tool_batch_block",
        category: "control_tag",
        scope: "block",
        pattern: "\\[VOX_TOOL_BATCH\\][\\s\\S]*?\\[/VOX_TOOL_BATCH\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[VOX_TOOL_BATCH]",
        description: "IDE tool-call envelope (paired). Must never reach the user."
      },
      {
        id: "vox_tool_batch_lone",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[/?VOX_TOOL_BATCH\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[VOX_TOOL_BATCH]",
        description: "Unpaired VOX_TOOL_BATCH open/close tag."
      },
      {
        id: "private_ide_context",
        category: "control_tag",
        scope: "block",
        pattern: "\\[PRIVATE_IDE_CONTEXT\\][\\s\\S]*?\\[/PRIVATE_IDE_CONTEXT\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[PRIVATE_IDE_CONTEXT]",
        description: "IDE dynamic context packet (paired)."
      },
      {
        id: "private_ide_context_lone",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[/?PRIVATE_IDE_CONTEXT\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[PRIVATE_IDE_CONTEXT]",
        description: "Unpaired PRIVATE_IDE_CONTEXT tag."
      },
      {
        id: "workspace_correction",
        category: "control_tag",
        scope: "block",
        pattern: "\\[WORKSPACE_CORRECTION\\][\\s\\S]*?\\[/WORKSPACE_CORRECTION\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[WORKSPACE_CORRECTION]",
        description: "IDE workspace-correction envelope (paired)."
      },
      {
        id: "visual_inspection",
        category: "control_tag",
        scope: "block",
        pattern: "\\[VISUAL_INSPECTION\\][\\s\\S]*?\\[/VISUAL_INSPECTION\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[VISUAL_INSPECTION]",
        description: "IDE eyes-loop vision feedback (paired)."
      },
      {
        id: "ide_state_tags",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[/?(?:tool_result|request_context|raw_reply|validation_result|runtime_result|tool_error|action_summary|force_finalize)\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[",
        description: "IDE per-turn state tags the client render-gates already reject; centralized here."
      },
      {
        id: "style_tag",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[STYLE:[^\\]]*\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[STYLE:",
        description: "Leader style directive tag."
      },
      {
        id: "note_tag",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[NOTE:[^\\]]*\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[NOTE:",
        description: "Editor live-thinking note; must never leak."
      },
      {
        id: "control_family_tags",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[(?:TEMPLATE|TONE|FORMAT|MODE):[^\\]]*\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[",
        description: "TEMPLATE/TONE/FORMAT/MODE control tag family."
      },
      {
        id: "skill_tag",
        category: "control_tag",
        scope: "inline",
        pattern: "\\[SKILL:[^\\]]*\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[SKILL:",
        description: "Skill-selection marker."
      },
      {
        id: "websearch_tag",
        category: "tool_xml",
        scope: "inline",
        pattern: "\\[WEBSEARCH\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[WEBSEARCH]",
        description: "Websearch tool tag."
      },
      {
        id: "search_query_tag",
        category: "tool_xml",
        scope: "inline",
        pattern: "\\[SEARCH:[^\\]]*\\]",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "[SEARCH:",
        description: "Search query tag."
      },
      {
        id: "tool_xml_tags",
        category: "tool_xml",
        scope: "inline",
        pattern: "</?(?:search|websearch|web_search|tool_code|tool_call|function_call|get_info)[^>]*>",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "<",
        description: "Tool/function XML artifacts the model emits instead of answering."
      },
      {
        id: "search_query_selfclose",
        category: "tool_xml",
        scope: "inline",
        pattern: "<search\\s+query=[^>]*/?>",
        flags: "i",
        action: "remove",
        stream_risk: true,
        open: "<search",
        description: '<search query="..."/> self-closing artifact.'
      },
      {
        id: "identity_leak",
        category: "identity_leak",
        scope: "inline",
        pattern: "\\b(?:as an AI language model|as an AI assistant|as a language model|as an assistant|as an AI(?=[,.]))\\b[,]?\\s*",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "AI-identity disclaimers (bare 'as an AI' only when it's a disclaimer, i.e. followed by comma/period)."
      },
      {
        id: "process_leak_analysis",
        category: "process_leak",
        scope: "inline",
        pattern: "\\b(?:the analysis shows|the agents found|according to my analysis|my research indicates)\\b",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Internal-process narration leak."
      },
      {
        id: "process_leak_swarm",
        category: "process_leak",
        scope: "inline",
        pattern: "\\b(?:based on the chain script|the chain script|agent memo|specialist agents?)\\b",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Swarm-internals leak (chain script, agent memo, specialist agents)."
      },
      {
        id: "scaffold_style_line",
        category: "scaffold_line",
        scope: "line",
        pattern: "^\\s*(?:answer\\s+)?style\\s*[:=]\\s*(?:conversational|short_sweet|programmer|structured|gpt_style|grok_style|gemini_style|claude_style|emoji_fun|long_detailed|creative_constraint|formal|sympathy)\\s*\\.?\\s*$",
        flags: "im",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Whole-line style scaffold echoed from the system prompt (known template ids only)."
      },
      {
        id: "scaffold_headers",
        category: "scaffold_line",
        scope: "line",
        pattern: "^\\s*(?:subtasks?|output\\s+control(?:\\s*\\([^)]*\\))?|answer\\s+output|required\\s+structure\\s+compliance)\\s*:?\\s*$",
        flags: "im",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Leader subtask scaffold headers echoed verbatim."
      },
      {
        id: "preamble",
        category: "preamble",
        scope: "prefix",
        pattern: "^\\s*(?:Sure!|Of course!|Great question!|Absolutely!|Certainly!|Happy to help!|I'd be happy to help!|Let me help you with that[.!]|Here's what I found:?|Hey there!|Oh,? (?:great|good|awesome|fantastic) question!?|Wow,? (?:great|good|fantastic|awesome|what a) (?:question|topic)!?|That's (?:a really |such a )?(?:fun|interesting|important|great|fantastic) (?:question|topic|one)!?|That's a (?:great|fantastic|excellent|wonderful|really good|awesome) question!?|I'll do my best to|Let me explain:?)\\s*",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Generic opening pleasantries (only at the very start of the answer)."
      },
      {
        id: "trailing_fluff",
        category: "trailing_fluff",
        scope: "suffix",
        pattern: "\\s*(?:Let me know if you have any other questions[.!]?|Feel free to ask if you need anything else[.!]?|Hope this helps[.!]?|I hope this (?:helps|answers your question)[.!]?|Don't hesitate to ask[.!]?|Let me know if you(?:'d| would) like[^.!?\\n]{0,120}[.!?]?)\\s*$",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Trailing sign-off fluff (only at the very end; offer-questions handled by policy)."
      },
      {
        id: "trailing_offer",
        category: "trailing_offer",
        scope: "suffix",
        pattern: "\\s*(?:Need me to|Want (?:a|the|me to|to)|Would you like(?: me)? to|Do you want(?: me)? to|Should I|If you(?:'d| would) like,? I can|If you want,? I can|I can also|Happy to)[^\\n]{2,200}[?.!]\\s*$",
        flags: "i",
        action: "remove",
        stream_risk: false,
        open: "",
        description: "Trailing unsolicited follow-up offer. Stripped ONLY under the strict profile (see policies)."
      }
    ]
  };

  // ../../spec/policies.json
  var policies_default = {
    $schema_version: "1.0.0",
    description: "Per-surface profiles for the Vox Text Engine. A profile selects which marker CATEGORIES are stripped and how normalization behaves. The `filter` mode (strict|conversational|auto) layers on top: strict adds the `strict_extra` categories (preamble/fluff/offers), conversational keeps them. `auto` resolves to strict when intent is a deliverable (code/analysis/compare/search) else conversational. Categories come from markers.json.",
    filter_auto_strict_intents: ["code", "analysis", "compare", "search"],
    profiles: {
      chat: {
        description: "Conversational assistant. Always kill internal leaks + opening pleasantries; keep a friendly closing hook unless strict.",
        base_strip: ["control_tag", "tool_xml", "identity_leak", "process_leak", "scaffold_line", "preamble"],
        strict_extra: ["trailing_fluff", "trailing_offer"],
        normalize: {
          unwrap_markdown_fence: true,
          collapse_blank_lines: true,
          trim_line_whitespace: true,
          structural_repair: true,
          plain_speech: false,
          preserve_repeats: false
        },
        reveal_default: "stream"
      },
      ide: {
        description: "Terse coding surface. Strip everything internal AND all fluff/offers \u2014 the coder speaks plainly.",
        base_strip: ["control_tag", "tool_xml", "identity_leak", "process_leak", "scaffold_line", "preamble"],
        strict_extra: ["trailing_fluff", "trailing_offer"],
        force_strict: true,
        normalize: {
          unwrap_markdown_fence: true,
          collapse_blank_lines: true,
          trim_line_whitespace: true,
          structural_repair: true,
          plain_speech: false,
          preserve_repeats: false
        },
        reveal_default: "stream"
      },
      music: {
        description: "Lyrics/descriptions. Strip only leaked internal tags \u2014 NEVER strip preamble/fluff/repeats (a chorus repeat or an 'oooh' is content, not fluff). Preserve section headers and blank-line structure.",
        base_strip: ["control_tag", "tool_xml"],
        strict_extra: [],
        normalize: {
          unwrap_markdown_fence: true,
          collapse_blank_lines: false,
          trim_line_whitespace: true,
          structural_repair: false,
          plain_speech: false,
          preserve_repeats: true,
          preserve_line_breaks: true
        },
        reveal_default: "instant"
      },
      voice: {
        description: "TTS. Strip everything internal + all fluff, then flatten markdown to speakable plain text.",
        base_strip: ["control_tag", "tool_xml", "identity_leak", "process_leak", "scaffold_line", "preamble"],
        strict_extra: ["trailing_fluff", "trailing_offer"],
        force_strict: true,
        normalize: {
          unwrap_markdown_fence: true,
          collapse_blank_lines: true,
          trim_line_whitespace: true,
          structural_repair: true,
          plain_speech: true,
          preserve_repeats: false
        },
        reveal_default: "instant"
      }
    }
  };

  // ../../spec/reveal.json
  var reveal_default = {
    $schema_version: "1.0.0",
    description: "Reveal ('typing') cadence presets. The reveal stage runs AFTER filter+parse, so it can emit whole structural blocks (a code card appears at once) while prose reveals gradually. `unit` = what each tick emits; `rate` = units per tick; `atomic_blocks` = block types emitted whole (never mid-typed).",
    presets: {
      instant: {
        description: "Emit the whole output in one shot.",
        mode: "instant"
      },
      stream: {
        description: "Pass model deltas straight through as they arrive (already filtered stream-safe).",
        mode: "passthrough"
      },
      typewriter: {
        description: "Deliberate typed reveal for prose; structural blocks appear whole.",
        mode: "cadence",
        unit: "word",
        rate: 3,
        tick_ms: 40,
        atomic_blocks: ["code", "table", "media"]
      }
    }
  };

  // src/spec.ts
  function compile(pattern, flags, global) {
    const f = (flags || "") + (global ? "g" : "");
    return new RegExp(pattern, f);
  }
  var Spec = class {
    version;
    markers;
    policies;
    reveal;
    maxOpenLen;
    openLeads;
    constructor(markersDoc, policiesDoc, revealDoc) {
      this.policies = policiesDoc;
      this.reveal = revealDoc;
      this.version = markersDoc["$schema_version"] ?? "0";
      this.markers = (markersDoc.markers ?? []).map((m) => ({
        id: m.id,
        category: m.category,
        scope: m.scope,
        pattern: m.pattern,
        flags: m.flags ?? "",
        action: m.action ?? "remove",
        streamRisk: !!m.stream_risk,
        open: m.open ?? "",
        replacement: m.replacement ?? "",
        re: compile(m.pattern, m.flags ?? "", false),
        reg: compile(m.pattern, m.flags ?? "", true)
      }));
      const openLens = this.markers.filter((m) => m.streamRisk && m.open).map((m) => m.open.length);
      this.maxOpenLen = openLens.length ? Math.max(...openLens, 1) : 1;
      this.openLeads = Array.from(
        new Set(this.markers.filter((m) => m.streamRisk && m.open).map((m) => m.open[0]))
      ).sort();
    }
  };
  var SINGLETON = null;
  function setSpec(s) {
    SINGLETON = s;
  }
  function getSpec() {
    if (SINGLETON === null) {
      throw new Error("Vox Text Engine spec not initialized \u2014 call setSpec() first.");
    }
    return SINGLETON;
  }
  function resolveProfile(spec, surface, opts = {}) {
    const filterMode = opts.filterMode ?? "auto";
    const profiles = spec.policies.profiles ?? {};
    const raw = profiles[surface] ?? profiles["chat"];
    const base = raw.base_strip ?? [];
    const strictExtra = raw.strict_extra ?? [];
    let strict;
    if (raw.force_strict) strict = true;
    else if (filterMode === "strict") strict = true;
    else if (filterMode === "conversational") strict = false;
    else {
      const autoIntents = new Set(spec.policies.filter_auto_strict_intents ?? []);
      strict = !!(opts.intent && autoIntents.has(opts.intent));
    }
    const cats = new Set(base);
    if (strict) for (const c of strictExtra) cats.add(c);
    return {
      name: surface,
      stripCategories: cats,
      strict,
      normalize: { ...raw.normalize ?? {} },
      reveal: opts.reveal ?? raw.reveal_default ?? "stream"
    };
  }

  // src/emit.ts
  var TS_CODE_LANGS = /* @__PURE__ */ new Set([
    "ts",
    "typescript",
    "tsx",
    "js",
    "javascript",
    "jsx",
    "mjs",
    "cjs"
  ]);
  function spansMd(spans) {
    return spans.map((s) => {
      if (s.kind === "strong") return `**${s.text}**`;
      if (s.kind === "em") return `*${s.text}*`;
      if (s.kind === "code") return `\`${s.text}\``;
      if (s.kind === "link") return `[${s.text}](${s.href ?? ""})`;
      return s.text;
    }).join("");
  }
  function blockMd(b) {
    switch (b.t) {
      case "p":
        return spansMd(b.spans ?? []);
      case "heading":
        return `${"#".repeat(b.level ?? 1)} ${spansMd(b.spans ?? [])}`;
      case "code":
        return "```" + (b.lang ?? "") + "\n" + (b.code ?? "") + "\n```";
      case "hr":
        return "---";
      case "quote": {
        const inner = emitMarkdown(b.children ?? []);
        return inner.split("\n").map((ln) => ln ? `> ${ln}` : ">").join("\n");
      }
      case "list": {
        const rows = (b.items ?? []).map((item, idx) => {
          const marker = b.ordered ? `${idx + 1}.` : "-";
          return `${marker} ${emitMarkdown(item)}`;
        });
        return rows.join("\n");
      }
      case "table": {
        const head = "| " + (b.head ?? []).map(spansMd).join(" | ") + " |";
        const sep = "| " + (b.head ?? []).map(() => "---").join(" | ") + " |";
        const body = (b.rows ?? []).map(
          (row) => "| " + row.map(spansMd).join(" | ") + " |"
        );
        return [head, sep, ...body].join("\n");
      }
      default:
        return "";
    }
  }
  function emitMarkdown(blocks) {
    return blocks.map(blockMd).join("\n\n").trim();
  }
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeUrl(u) {
    const ul = (u ?? "").trim();
    const low = ul.toLowerCase();
    if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("mailto:") || low.startsWith("/") || low.startsWith("#") || low.startsWith("data:image/")) {
      return ul;
    }
    return "";
  }
  function spansHtml(spans) {
    return spans.map((s) => {
      if (s.kind === "strong") return `<strong>${esc(s.text)}</strong>`;
      if (s.kind === "em") return `<em>${esc(s.text)}</em>`;
      if (s.kind === "code") return `<code>${esc(s.text)}</code>`;
      if (s.kind === "link") {
        const href = safeUrl(s.href ?? "");
        return href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(s.text)}</a>` : esc(s.text);
      }
      return esc(s.text).replace(/\n/g, "<br>");
    }).join("");
  }
  function blockHtml(b) {
    switch (b.t) {
      case "p":
        return `<p>${spansHtml(b.spans ?? [])}</p>`;
      case "heading":
        return `<h${b.level}>${spansHtml(b.spans ?? [])}</h${b.level}>`;
      case "code": {
        const cls = b.lang ? ` class="language-${esc(b.lang)}"` : "";
        return `<pre><code${cls}>${esc(b.code ?? "")}</code></pre>`;
      }
      case "hr":
        return "<hr>";
      case "quote":
        return `<blockquote>${emitHtml(b.children ?? [])}</blockquote>`;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const items = (b.items ?? []).map((item) => `<li>${emitItemHtml(item)}</li>`).join("");
        return `<${tag}>${items}</${tag}>`;
      }
      case "table": {
        const head = (b.head ?? []).map((c) => `<th>${spansHtml(c)}</th>`).join("");
        const body = (b.rows ?? []).map((row) => "<tr>" + row.map((c) => `<td>${spansHtml(c)}</td>`).join("") + "</tr>").join("");
        return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      }
      default:
        return "";
    }
  }
  function emitHtml(blocks) {
    return blocks.map(blockHtml).join("");
  }
  function emitItemHtml(blocks) {
    if (blocks.length === 1 && blocks[0].t === "p") return spansHtml(blocks[0].spans ?? []);
    return blocks.map(blockHtml).join("");
  }
  function tsEscapeTemplate(s) {
    return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  }
  function commentLines(text) {
    return text.split("\n").map((ln) => ln ? `// ${ln}` : "//").join("\n");
  }
  function emitTypescript(blocks) {
    const hasTsCode = blocks.some(
      (b) => b.t === "code" && TS_CODE_LANGS.has((b.lang ?? "").toLowerCase())
    );
    if (!blocks.some((b) => b.t === "code")) {
      const prose = emitMarkdown(blocks);
      const header = commentLines("Generated by Vox Text Engine \u2014 prose deliverable.");
      return `${header}
export const content: string = \`${tsEscapeTemplate(prose)}\`;
`;
    }
    const out = [];
    for (const b of blocks) {
      if (b.t === "code") {
        const lang = (b.lang ?? "").toLowerCase();
        if (TS_CODE_LANGS.has(lang) || lang === "") {
          out.push((b.code ?? "").replace(/\s+$/, ""));
        } else {
          out.push(`/* lang: ${lang}
${(b.code ?? "").replace(/\s+$/, "")}
*/`);
        }
      } else {
        const md = blockMd(b).trim();
        if (md) out.push(commentLines(md));
      }
    }
    let body = out.filter((p) => p.trim()).join("\n\n");
    if (!hasTsCode) {
      body = commentLines("No TypeScript/JavaScript code in this deliverable.") + "\n\n" + body;
    }
    return body.replace(/\s+$/, "") + "\n";
  }
  function emit(blocks, fmt) {
    if (fmt === "markdown") return emitMarkdown(blocks);
    if (fmt === "html") return emitHtml(blocks);
    if (fmt === "typescript") return emitTypescript(blocks);
    throw new Error(`unknown format: ${fmt}`);
  }

  // src/filter.ts
  var BATCH_SCOPES = ["block", "inline", "line"];
  var TAGISH = /^\/?[A-Za-z_][A-Za-z0-9_:\- ]*$/;
  var CODE_SPAN = /^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```|`[^`\n]+`/gm;
  var codePlaceholder = (i) => `\0VTECODE${i}\0`;
  function protectCode(text) {
    const spans = [];
    const masked = text.replace(CODE_SPAN, (m) => {
      spans.push(m);
      return codePlaceholder(spans.length - 1);
    });
    return { masked, spans };
  }
  function restoreCode(text, spans) {
    for (let i = 0; i < spans.length; i++) {
      text = text.replaceAll(codePlaceholder(i), spans[i]);
    }
    return text;
  }
  function deriveClose(openLiteral) {
    if (openLiteral.length >= 1 && (openLiteral[0] === "[" || openLiteral[0] === "<")) {
      return openLiteral[0] + "/" + openLiteral.slice(1);
    }
    return openLiteral;
  }
  function applyScope(markers, cats, text, scope) {
    for (const m of markers) {
      if (cats.has(m.category) && m.scope === scope) {
        const repl = m.action === "replace" ? m.replacement : "";
        text = text.replace(m.reg, repl);
      }
    }
    return text;
  }
  function applyBoundary(markers, cats, text, scope) {
    for (const m of markers) {
      if (cats.has(m.category) && m.scope === scope) {
        let prev = null;
        let guard = 0;
        while (prev !== text && guard < 16) {
          prev = text;
          text = text.replace(scope === "prefix" ? m.re : m.reg, "");
          guard += 1;
        }
      }
    }
    return text;
  }
  function filterSegment(spec, profile, text, isStart, isEnd) {
    const cats = profile.stripCategories;
    for (const scope of BATCH_SCOPES) {
      text = applyScope(spec.markers, cats, text, scope);
    }
    if (isStart) text = applyBoundary(spec.markers, cats, text, "prefix");
    if (isEnd) text = applyBoundary(spec.markers, cats, text, "suffix");
    return text;
  }
  function filterText(spec, profile, text) {
    const { masked, spans } = protectCode(text);
    const filtered = filterSegment(spec, profile, masked, true, true);
    return restoreCode(filtered, spans);
  }
  var StreamFilter = class {
    buffer = "";
    started = false;
    spec;
    profile;
    constructor(spec, profile) {
      this.spec = spec;
      this.profile = profile;
    }
    feed(delta) {
      this.buffer += delta;
      return this.drain(false);
    }
    flush() {
      return this.drain(true);
    }
    holdIndex(s) {
      let best = s.length;
      const cats = this.profile.stripCategories;
      const low = s.toLowerCase();
      for (const m of this.spec.markers) {
        if (m.scope !== "block" || !m.streamRisk || !cats.has(m.category) || !m.open) continue;
        const oi = low.indexOf(m.open.toLowerCase());
        if (oi !== -1) {
          const close = deriveClose(m.open).toLowerCase();
          if (low.indexOf(close, oi + m.open.length) === -1) {
            best = Math.min(best, oi);
          }
        }
      }
      for (const [lead, close] of [["[", "]"], ["<", ">"]]) {
        const i = s.lastIndexOf(lead);
        if (i === -1) continue;
        const tail = s.slice(i);
        if (tail.includes(close)) continue;
        const body = tail.slice(1);
        if (body === "" || tail.length <= this.spec.maxOpenLen + 48 && TAGISH.test(body)) {
          best = Math.min(best, i);
        }
      }
      return best;
    }
    drain(final) {
      if (final) {
        const out2 = filterSegment(this.spec, this.profile, this.buffer, !this.started, true);
        this.buffer = "";
        if (out2) this.started = true;
        return out2;
      }
      const hold = this.holdIndex(this.buffer);
      const emitPart = this.buffer.slice(0, hold);
      this.buffer = this.buffer.slice(hold);
      if (!emitPart) return "";
      const out = filterSegment(this.spec, this.profile, emitPart, !this.started, false);
      if (out) this.started = true;
      return out;
    }
  };

  // src/ir.ts
  function span(kind, text, href) {
    return href === void 0 ? { kind, text } : { kind, text, href };
  }
  function blockToDict(b) {
    const d = { t: b.t };
    if (b.t === "p" || b.t === "heading") {
      d.spans = (b.spans ?? []).map(spanToDict);
    }
    if (b.t === "heading") d.level = b.level ?? 0;
    if (b.t === "list") {
      d.ordered = b.ordered ?? false;
      d.items = (b.items ?? []).map((item) => item.map(blockToDict));
    }
    if (b.t === "code") {
      d.lang = b.lang ?? "";
      d.code = b.code ?? "";
    }
    if (b.t === "table") {
      d.head = (b.head ?? []).map((cell) => cell.map(spanToDict));
      d.rows = (b.rows ?? []).map((row) => row.map((cell) => cell.map(spanToDict)));
    }
    if (b.t === "quote") {
      d.children = (b.children ?? []).map(blockToDict);
    }
    return d;
  }
  function spanToDict(s) {
    const d = { kind: s.kind, text: s.text };
    if (s.href !== void 0) d.href = s.href;
    return d;
  }

  // src/normalize.ts
  var WHOLE_FENCE = /^```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```$/;
  var LOOKS_MD = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/;
  function unwrapMarkdownFence(text) {
    const t = text.trim();
    const m = WHOLE_FENCE.exec(t);
    if (!m) return text;
    const lang = (m[1] ?? "").trim().toLowerCase();
    const inner = m[2] ?? "";
    if (lang === "markdown" || lang === "md") return inner;
    if (lang === "" && LOOKS_MD.test(inner)) return inner;
    return text;
  }
  function countOccurrences(s, sub) {
    let n = 0;
    let i = s.indexOf(sub);
    while (i !== -1) {
      n += 1;
      i = s.indexOf(sub, i + sub.length);
    }
    return n;
  }
  function repairFences(text) {
    return countOccurrences(text, "```") % 2 === 1 ? text + "\n```" : text;
  }
  function repairBold(text) {
    const scan = text.replace(/^\s*(?:[-*_]\s*){3,}\s*$/gm, "");
    if (countOccurrences(scan, "**") % 2 === 1) {
      const idx = text.lastIndexOf("**");
      if (idx !== -1) text = text.slice(0, idx) + text.slice(idx + 2);
    }
    return text;
  }
  function repairLists(text) {
    text = text.replace(/([^\n])(\n- )/g, "$1\n$2");
    text = text.replace(/([^\n])(\n\d+\. )/g, "$1\n$2");
    return text;
  }
  function trimLinesPreserveCode(text) {
    const lines = text.split("\n");
    const out = [];
    let inCode = false;
    for (const line of lines) {
      if (line.trimStart().startsWith("```")) {
        inCode = !inCode;
        out.push(line);
      } else if (inCode) {
        out.push(line);
      } else {
        out.push(line.replace(/\s+$/, ""));
      }
    }
    return out.join("\n");
  }
  function toPlainSpeech(text) {
    text = text.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g, "$1");
    text = text.replace(/`([^`]*)`/g, "$1");
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    text = text.replace(/^\s{0,3}>\s?/gm, "");
    text = text.replace(/^\s{0,3}[-*+]\s+/gm, "");
    text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    text = text.replace(/\n{2,}/g, "\n");
    return text.trim();
  }
  function normalizeText(text, opts) {
    if (opts.unwrap_markdown_fence ?? true) text = unwrapMarkdownFence(text);
    if (opts.structural_repair ?? true) {
      text = repairFences(text);
      text = repairBold(text);
      text = repairLists(text);
    }
    if (opts.trim_line_whitespace ?? true) text = trimLinesPreserveCode(text);
    if (opts.collapse_blank_lines ?? true) text = text.replace(/\n{3,}/g, "\n\n");
    if (opts.plain_speech ?? false) text = toPlainSpeech(text);
    return text.replace(/^\n+/, "").replace(/\n+$/, "");
  }

  // src/parse.ts
  var HEADING = /^(#{1,6})\s+(.*)$/;
  var FENCE = /^```([a-zA-Z0-9_+#.-]*)\s*$/;
  var HR = /^\s*(?:[-*_]\s*){3,}$/;
  var ULI = /^\s*[-*+]\s+(.*)$/;
  var OLI = /^\s*\d+\.\s+(.*)$/;
  var QUOTE = /^\s*>\s?(.*)$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
  var LINK_STICKY = /\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/y;
  function parseInline(text) {
    const spans = [];
    let buf = [];
    let i = 0;
    const n = text.length;
    const flush = () => {
      if (buf.length) {
        spans.push(span("text", buf.join("")));
        buf = [];
      }
    };
    while (i < n) {
      const c = text[i];
      if (c === "`") {
        const j = text.indexOf("`", i + 1);
        if (j !== -1) {
          flush();
          spans.push(span("code", text.slice(i + 1, j)));
          i = j + 1;
          continue;
        }
      }
      if (text.startsWith("**", i)) {
        const j = text.indexOf("**", i + 2);
        if (j !== -1) {
          flush();
          spans.push(span("strong", text.slice(i + 2, j)));
          i = j + 2;
          continue;
        }
      }
      if (c === "*" || c === "_") {
        const j = text.indexOf(c, i + 1);
        if (j > i + 1) {
          flush();
          spans.push(span("em", text.slice(i + 1, j)));
          i = j + 1;
          continue;
        }
      }
      if (c === "[") {
        LINK_STICKY.lastIndex = i;
        const m = LINK_STICKY.exec(text);
        if (m && m.index === i) {
          flush();
          spans.push(span("link", m[1], m[2]));
          i = i + m[0].length;
          continue;
        }
      }
      buf.push(c);
      i += 1;
    }
    flush();
    return spans;
  }
  function rowCells(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  function isSpecial(lines, i) {
    const line = lines[i];
    if (HEADING.test(line) || FENCE.test(line.trim()) || HR.test(line)) return true;
    if (QUOTE.test(line) || ULI.test(line) || OLI.test(line)) return true;
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) return true;
    return false;
  }
  function parse(text, opts) {
    const preserveBreaks = !!(opts && opts.preserve_line_breaks);
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    const n = lines.length;
    while (i < n) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const fence = FENCE.exec(line.trim());
      if (fence) {
        const lang = fence[1] ?? "";
        const codeLines = [];
        i += 1;
        while (i < n && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < n) i += 1;
        blocks.push({ t: "code", lang, code: codeLines.join("\n") });
        continue;
      }
      if (HR.test(line)) {
        blocks.push({ t: "hr" });
        i += 1;
        continue;
      }
      const h = HEADING.exec(line);
      if (h) {
        const level = Math.min(6, Math.max(1, h[1].length));
        blocks.push({ t: "heading", level, spans: parseInline(h[2].trim()) });
        i += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const qLines = [];
        while (i < n && QUOTE.test(lines[i])) {
          qLines.push(QUOTE.exec(lines[i])[1]);
          i += 1;
        }
        blocks.push({ t: "quote", children: parse(qLines.join("\n"), opts) });
        continue;
      }
      if (line.includes("|") && i + 1 < n && TABLE_SEP.test(lines[i + 1])) {
        const head = rowCells(line).map(parseInline);
        i += 2;
        const rows = [];
        while (i < n && lines[i].includes("|") && lines[i].trim()) {
          rows.push(rowCells(lines[i]).map(parseInline));
          i += 1;
        }
        blocks.push({ t: "table", head, rows });
        continue;
      }
      if (ULI.test(line) || OLI.test(line)) {
        const ordered = OLI.test(line);
        const itemRe = ordered ? OLI : ULI;
        const items = [];
        while (i < n) {
          const m = itemRe.exec(lines[i]);
          if (m) {
            items.push([{ t: "p", spans: parseInline(m[1].trim()) }]);
            i += 1;
          } else if (!lines[i].trim() && i + 1 < n && itemRe.test(lines[i + 1])) {
            i += 1;
          } else {
            break;
          }
        }
        blocks.push({ t: "list", ordered, items });
        continue;
      }
      const para = [];
      while (i < n && lines[i].trim() && !isSpecial(lines, i)) {
        para.push(lines[i].trim());
        i += 1;
      }
      blocks.push({ t: "p", spans: parseInline(para.join(preserveBreaks ? "\n" : " ")) });
    }
    return blocks;
  }

  // src/reveal.ts
  function* revealEvents(spec, outputText, presetName) {
    const preset = spec.reveal?.presets?.[presetName] ?? { mode: "instant" };
    const mode = preset.mode ?? "instant";
    if (mode === "instant" || mode === "passthrough") {
      yield { kind: "done", text: outputText };
      return;
    }
    const unit = preset.unit ?? "word";
    const rate = Number(preset.rate ?? 3);
    const sep = unit === "word" ? " " : "";
    const tokens = unit === "word" ? outputText.split(" ") : Array.from(outputText);
    let group = [];
    for (const tok of tokens) {
      group.push(tok);
      if (group.length >= rate) {
        yield { kind: "delta", text: group.join(sep) + (unit === "word" ? sep : "") };
        group = [];
      }
    }
    if (group.length) yield { kind: "delta", text: group.join(sep) };
    yield { kind: "done", text: outputText };
  }

  // src/engine.ts
  var EMPTY_FALLBACK = "I don't have a clean response to show for that. Please try again or rephrase.";
  function profileFor(inp) {
    const spec = getSpec();
    const profile = resolveProfile(spec, inp.surface ?? "chat", {
      filterMode: inp.filter ?? "auto",
      intent: inp.intent ?? null,
      reveal: inp.reveal ?? null
    });
    return { spec, profile };
  }
  function process(inp) {
    const { spec, profile } = profileFor(inp);
    const fmt = inp.format ?? "markdown";
    const diagnostics = [];
    const raw = inp.content ?? "";
    const filtered = filterText(spec, profile, raw);
    if (filtered !== raw) diagnostics.push({ stage: "filter", changed: true });
    let normalized = normalizeText(filtered, profile.normalize);
    if (raw.trim() && !normalized.trim()) {
      diagnostics.push({ stage: "fallback", reason: "empty_after_filter" });
      normalized = EMPTY_FALLBACK;
    }
    const blocks = parse(normalized, profile.normalize);
    const outText = emit(blocks, fmt);
    return {
      text: outText,
      format: fmt,
      blocks: blocks.map(blockToDict),
      diagnostics
    };
  }
  function* processStream(deltas, inp) {
    const { spec, profile } = profileFor(inp);
    const sf = new StreamFilter(spec, profile);
    for (const d of deltas) {
      const out = sf.feed(d);
      if (out) yield out;
    }
    const tail = sf.flush();
    if (tail) yield tail;
  }
  function* reveal(inp) {
    const { spec, profile } = profileFor(inp);
    const out = process(inp);
    yield* revealEvents(spec, out.text, inp.reveal ?? profile.reveal);
  }

  // src/browser.ts
  setSpec(new Spec(markers_default, policies_default, reveal_default));
  globalThis.VTE = { process, processStream, reveal };
  return __toCommonJS(browser_exports);
})();
