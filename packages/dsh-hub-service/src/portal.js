import { portalApiScript } from './portal-api.js';
import { portalStyles } from './portal-styles.js';
import { portalUiScript } from './portal-ui.js';

export function portalHtml({ nonce }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-hub portal</title>
<style nonce="${nonce}">
${portalStyles}
</style>
</head>
<body>
<header>
  <h1>dsh-hub <span class="subtitle">管理后台</span></h1>
  <span class="user" id="user"></span>
</header>
<div class="layout">
  <nav id="nav"></nav>
  <main>
    <section id="view-dashboard"></section>
    <section id="view-namespaces" class="hidden"></section>
    <section id="view-instances" class="hidden"></section>
    <section id="view-users" class="hidden"></section>
    <section id="view-audit" class="hidden"></section>
  </main>
</div>

<div id="modal">
  <div class="frame">
    <div class="bar"><span id="modalTitle"></span><button id="closeModalButton" class="secondary" type="button">关闭</button></div>
    <iframe id="modalFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe>
  </div>
</div>

<script nonce="${nonce}">
${portalApiScript}
${portalUiScript}
</script>
</body>
</html>`;
}
