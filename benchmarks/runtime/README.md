# Runtime benchmarks

Application-shaped workloads for measuring the speed of compiled executables. Each workload is deterministic, generates its own input (or reads a generated file), and prints a summary that must match Node.js byte-for-byte before it is timed.

| Workload | Exercises |
| --- | --- |
| `json-records` | `JSON.stringify`, typed `JSON.parse`, Map aggregation |
| `regex-logs` | regex `exec` with groups, `test`, global `replace` |
| `ast-interp` | tokenizer, recursive-descent parser, class dispatch |
| `records-sort` | comparator sorts, group-by, `reduce`/`filter` |
| `template-render` | template literals, escaping, `map`/`join` |
| `functional-pipeline` | `filter`/`map`/`reduce`/`flatMap` chains, closures, small records |
| `async-pipeline` | `async`/`await`, `Promise.all` fan-out |
| `word-graph` | string-keyed Map/Set, BFS |
| `alloc-trees` | allocation-heavy trees, immutable object-spread updates |
| `numeric-kernels` | sieve, hashing, `number[][]` matmul, `Float64Array` |
| `validate-errors` | throw/catch on a fraction of inputs, small call chains |
| `csv-numbers` | `split`, `Number`, `parseInt`, `toFixed` |
| `log-summary`, `inventory-report` | the multi-module applications from `benchmarks/builds`, on 300k-line inputs |

Compare two checkouts (each with a built CLI and native artifacts for the host):

```console
$ pnpm bench:runtime --baseline=../scriptc-main --candidate=. --runs=15 --json=result.json
```

Without `--baseline`, the runner reports absolute medians. Baseline and candidate launches are interleaved, and each workload reports the median ratio with a bootstrap 95% confidence interval. `faster`/`slower` verdicts require the whole interval on one side of 1.0. A per-host lock serializes the timed phase so concurrent runs on one machine do not distort each other. Executables that time out or diverge from Node are reported, never timed.
