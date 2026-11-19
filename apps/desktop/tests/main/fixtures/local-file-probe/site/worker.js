const secrets = { sibling: 'secret.txt', outside: '../outside-secret.txt' };
async function tryFetch(url) {
  try { const text = await (await fetch(url)).text(); return text.includes('SECRET') ? 'read' : 'blocked: no secret'; }
  catch (error) { return 'blocked: ' + String(error); }
}
function tryXhr(url) {
  try { const xhr = new XMLHttpRequest(); xhr.open('GET', url, false); xhr.send(); return xhr.responseText.includes('SECRET') ? 'read' : 'blocked: status ' + String(xhr.status); }
  catch (error) { return 'blocked: ' + String(error); }
}
async function run() {
  const result = {};
  for (const [key, url] of Object.entries(secrets)) result[key] = { fetch: await tryFetch(url), xhr: tryXhr(url) };
  return result;
}
if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = (event) => { const port = event.ports[0]; void run().then((result) => port.postMessage(result)); };
} else {
  void run().then((result) => self.postMessage(result));
}
