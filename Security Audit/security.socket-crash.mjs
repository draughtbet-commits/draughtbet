// Local-only reproduction. No live database, Redis, user token or service used.
process.env.NODE_ENV='test';
process.env.JWT_SECRET='audit-local-synthetic-secret';
process.env.REDIS_URL='';
process.env.DATABASE_URL='';
const {createServer}=await import('node:http');
const {initSocketServer}=await import('./src/sockets/index.js');
const {io:client}=await import('socket.io-client');
const {default:jwt}=await import('jsonwebtoken');
const server=createServer();
initSocketServer(server);
server.listen(0,'127.0.0.1',()=>{
 const socket=client(`http://127.0.0.1:${server.address().port}`,{transports:['websocket'],reconnection:false,auth:{token:jwt.sign({userId:'audit-synthetic-user'},process.env.JWT_SECRET,{expiresIn:'1m'})}});
 socket.on('connect',()=>{console.log('LOCAL_AUTHENTICATED_SOCKET_CONNECTED');socket.emit('move_attempt',null);});
});
setTimeout(()=>{console.error('Reproduction did not crash within 3 seconds');process.exit(2);},3000).unref();
