### Task 9: PDF template and stylesheet (Style E)

**Files:**
- Create: `docker/vorlage/template.html`
- Create: `docker/vorlage/style.css`

**Interfaces:**
- Consumes: nothing (static assets).
- Produces: the two file paths referenced by `config.pandoc.templatePath` / `config.pandoc.cssPath` (Task 2), consumed by Task 11 (`pdf/renderPdf.ts`) and Task 15 (Dockerfile `COPY`).

This task has no automated test — it's a static visual asset, already approved via the visual-companion brainstorming session (Style E). Verification is a manual pandoc/weasyprint render, noted in the last step.

- [ ] **Step 1: Create the pandoc template**

```html
<!-- docker/vorlage/template.html -->
<!DOCTYPE html>
<html lang="$lang$">
<head>
<meta charset="utf-8">
<title>$title$</title>
</head>
<body>
<header class="doc-header">
  <div class="doc-header__fach">$fach$$if(lernfeld)$ · $lernfeld$$endif$</div>
  <div class="doc-header__title">$thema$</div>
  <div class="doc-header__meta">$name$ · $klasse$ · $datum$</div>
</header>
<main>
$body$
</main>
</body>
</html>
```

- [ ] **Step 2: Create the stylesheet (Style E: formal serif, thin colored left-rule labels)**

```css
/* docker/vorlage/style.css */
body {
  font-family: Georgia, 'Tinos', 'Liberation Serif', serif;
  color: #1a1a1a;
  margin: 2.5cm 2cm;
}

.doc-header {
  text-align: center;
  border-bottom: 2px solid #1a1a1a;
  padding-bottom: 12px;
  margin-bottom: 20px;
}

.doc-header__fach {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #555;
}

.doc-header__title {
  font-size: 21px;
  font-weight: bold;
  margin-top: 4px;
}

.doc-header__meta {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  color: #777;
  margin-top: 6px;
}

.task {
  border: 1px solid #e3e3e3;
  border-radius: 6px;
  padding: 16px 16px 16px 14px;
  margin-bottom: 14px;
  page-break-inside: avoid;
}

.task h2 {
  font-size: 15px;
  margin: 0 0 10px 0;
}

.frage,
.antwort {
  border-left: 2px solid;
  padding-left: 10px;
  margin-bottom: 12px;
}

.frage {
  border-left-color: #8892b0;
  font-style: italic;
  color: #333;
  font-size: 13px;
}

.antwort {
  border-left-color: #2f6b45;
  font-size: 13.5px;
  line-height: 1.6;
}

.frage::before,
.antwort::before {
  display: block;
  font-family: 'Liberation Sans', sans-serif;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  margin-bottom: 3px;
}

.frage::before {
  content: 'Frage';
  color: #8892b0;
}

.antwort::before {
  content: 'Antwort';
  color: #2f6b45;
}

.quelle {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  color: #888;
  padding-left: 10px;
}
```

- [ ] **Step 3: Commit**

```bash
git add docker/vorlage/template.html docker/vorlage/style.css
git commit -m "feat: add pandoc template and Style E stylesheet for solution PDFs"
```

- [ ] **Step 4 (manual verification, run once Task 15's Docker image is built):**

```bash
docker compose run --rm worker bash -c '
cat > /tmp/sample.md <<EOF
---
lang: de
fach: "BGWP"
thema: "Kaufvertragsrecht – Lösungen"
name: "Elias Helmer"
klasse: "IT10b"
datum: "2026-07-23"
---

:::: {.task}
## 1. Mangelhafte Lieferung

::: {.frage}
Ein Kunde erhält eine Ware mit Sachmangel. Welche Rechte stehen ihm nach BGB zu?
:::

::: {.antwort}
Der Käufer kann gemäß **§ 437 BGB** zunächst Nacherfüllung verlangen (§ 439 BGB).
:::

::: {.quelle}
§ 437, § 439 BGB
:::
::::
EOF
pandoc /tmp/sample.md --template /app/vorlage/template.html --css /app/vorlage/style.css \
  --pdf-engine=/app/.venv/bin/weasyprint -o /tmp/sample.pdf && ls -la /tmp/sample.pdf
'
```

Expected: `/tmp/sample.pdf` exists and is non-empty. Pull it out with `docker cp` and open it to confirm it visually matches the approved Style E mockup (serif header, colored left-rule Frage/Antwort labels, no filled badges).

---

