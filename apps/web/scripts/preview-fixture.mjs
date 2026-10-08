import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {'Content-Type':'text/event-stream', 'Cache-Control':'no-cache'});
    res.write('data: SSE 首条事件已收到（连接未关闭）\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1000);
    req.on('close', () => clearInterval(heartbeat));
    return;
  }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  res.end('<!doctype html><html><head><title>流式预览验证</title></head><body><h1>SSE 预览联调</h1><p id="result">正在等待事件…</p><script>const events=new EventSource("/events");events.onmessage=event=>document.getElementById("result").textContent=event.data;<\/script></body></html>');
});
server.listen(5183,'127.0.0.1',()=>console.log('SSE fixture listening on http://127.0.0.1:5183'));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close();});
