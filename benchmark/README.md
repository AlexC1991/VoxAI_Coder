Benchmark: Goose (this machine, v1.49.0) vs VoxAI Coder (same machine, v0.1.0)
Model both: ~deepseek/deepseek-v4-flash-latest (OpenRouter, $0.05/M in, $0.16/M out,
             $0.013/M cache-read). Tasks run in isolated dirs.

TASK (canonical, small, tool-heavy):
  "In the current directory create fib.py with:
     def fib(n): return n if n < 2 else fib(n-1) + fib(n-2)
   and a main block the prints fib(10). Then run `python fib.py` and
   report the exact output."

METRICS per run:
  - tool calls / turns
  - input tokens sent (cumulative)
  - cache-read tokens (provider prefix cache)
  - cache-miss (new) tokens
  - output tokens
  - elapsed
  - estimated cost (USD) from OpenRouter usage
  - session persistence / compaction behavior