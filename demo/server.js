/**
 * WARNING: This demo is a barebones implementation designed for development and evaluation
 * purposes only. It is definitely NOT production ready and does not aim to be so. Exposing the
 * demo to the public as is would introduce security risks for the host.
 **/

var express = require('express');
var expressWs = require('express-ws');
var os = require('os');
var pty = require('node-pty');
const cookieParser = require('cookie-parser');
const expressSession = require('express-session');
const bodyParser = require('body-parser');
const jsonParser = bodyParser.json();

const logininfo_id = 'admin';
const logininfo_pw = 'admin';

// Whether to use binary transport.
const USE_BINARY = os.platform() !== "win32";

function startServer() {
  var app = express();
  expressWs(app);

  var terminals = {},
    unsentOutput = {},
    temporaryDisposable = {};

  app.use('/xterm.css', express.static(__dirname + '/../css/xterm.css'));
  
  app.get('/logo.png', (req, res) => {
    res.sendFile(__dirname + '/logo.png');
  });

  app.get('/terminal', (req, res) => {
    res.sendFile(__dirname + '/index.html');
  });

  app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
  });

  app.get('/test', (req, res) => {
    res.sendFile(__dirname + '/test.html');
  });

  app.get('/style.css', (req, res) => {
    res.sendFile(__dirname + '/style.css');
  });
 
  app.get('/xterm.js', (req, res) => {
    if(!req.session.user) {
      console.log('not loin');
      res.redirect('/');
    }

    res.sendFile(__dirname + '../../node_modules/xterm/lib/xterm.js');
  });

  app.post('/login', jsonParser, (req, res) => {
    const {username, password} = req.body;
    
    if(req.session.user) {
      console.log("already login");
      res.redirect('/terminal');
    } else {
      if(username == logininfo_id && password == logininfo_pw) {
        req.session.user = 
          {
            id: username,
            name: username,
            authorized: true
          };
        res.writeHead(200,{"Content-Type":"text/html;characterset=utf8"});
        res.write('<h1>Login Success</h1>');
        res.write('<a href="/terminal">Move Terminal</a>');
        res.end();
      } else {
        console.log("login failed");
        res.redirect("/");
      }
    }
  });

  app.use('/dist', express.static(__dirname + '/dist'));
  app.use('/src', express.static(__dirname + '/src'));

  app.post('/terminals', (req, res) => {
    if(!req.session.user) {
      console.log('not login');
      res.redirect('/');
    }

    const env = Object.assign({}, process.env);
    env['COLORTERM'] = 'truecolor';
    var cols = parseInt(req.query.cols),
      rows = parseInt(req.query.rows),
      term = pty.spawn(process.platform === 'win32' ? 'pwsh.exe' : 'bash', [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.platform === 'win32' ? undefined : env.PWD,
        env: env,
        encoding: USE_BINARY ? null : 'utf8'
      });

    console.log('Created terminal with PID: ' + term.pid);
    terminals[term.pid] = term;
    unsentOutput[term.pid] = '';
    temporaryDisposable[term.pid] = term.onData(function(data) {
      unsentOutput[term.pid] += data;
    });
    res.send(term.pid.toString());
    res.end();
  });

  app.post('/terminals/:pid/size', (req, res) => {
    var pid = parseInt(req.params.pid),
        cols = parseInt(req.query.cols),
        rows = parseInt(req.query.rows),
        term = terminals[pid];

    term.resize(cols, rows);
    console.log('Resized terminal ' + pid + ' to ' + cols + ' cols and ' + rows + ' rows.');
    res.end();
  });

  app.ws('/terminals/:pid', function (ws, req) {
    var term = terminals[parseInt(req.params.pid)];
    console.log('Connected to terminal ' + term.pid);
    temporaryDisposable[term.pid].dispose();
    delete temporaryDisposable[term.pid];
    ws.send(unsentOutput[term.pid]);
    delete unsentOutput[term.pid];

    // unbuffered delivery after user input
    let userInput = false;

    // string message buffering
    function buffer(socket, timeout, maxSize) {
      let s = '';
      let sender = null;
      return (data) => {
        s += data;
        if (s.length > maxSize || userInput) {
          userInput = false;
          socket.send(s);
          s = '';
          if (sender) {
            clearTimeout(sender);
            sender = null;
          }
        } else if (!sender) {
          sender = setTimeout(() => {
            socket.send(s);
            s = '';
            sender = null;
          }, timeout);
        }
      };
    }
    // binary message buffering
    function bufferUtf8(socket, timeout, maxSize) {
      const dataBuffer = new Uint8Array(maxSize);
      let sender = null;
      let length = 0;
      return (data) => {
        function flush() {
          socket.send(Buffer.from(dataBuffer.buffer, 0, length));
          length = 0;
          if (sender) {
            clearTimeout(sender);
            sender = null;
          }
        }
        if (length + data.length > maxSize) {
          flush();
        }
        dataBuffer.set(data, length);
        length += data.length;
        if (length > maxSize || userInput) {
          userInput = false;
          flush();
        } else if (!sender) {
          sender = setTimeout(() => {
            sender = null;
            flush();
          }, timeout);
        }
      };
    }
    const send = (USE_BINARY ? bufferUtf8 : buffer)(ws, 5, 262144);

    // WARNING: This is a naive implementation that will not throttle the flow of data. This means
    // it could flood the communication channel and make the terminal unresponsive. Learn more about
    // the problem and how to implement flow control at https://xtermjs.org/docs/guides/flowcontrol/
    term.onData(function(data) {
      try {
        send(data);
      } catch (ex) {
        // The WebSocket is not open, ignore
      }
    });
    ws.on('message', function(msg) {
      term.write(msg);
      userInput = true;
    });
    ws.on('close', function () {
      term.kill();
      console.log('Closed terminal ' + term.pid);
      // Clean things up
      delete terminals[term.pid];

      console.log('auto logout');
      if(req.session.user) {
        req.session.destroy(
          function(err) {
            if(err) {
              console.log('session delete error');
            }
            console.log('sesson delete success');
          }
        );
      } else {
        console.log('status of not login');
      }
    });
  });

  var port = process.env.PORT || 3000,
      host = os.platform() === 'win32' ? '127.0.0.1' : '0.0.0.0';

  console.log('App listening to http://127.0.0.1:' + port);
  app.listen(port, host);
}

module.exports = startServer;
