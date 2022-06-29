import { ExecutionContext, ExecutionOutput } from '@superblocksteam/shared';
import {
  addLogListenersToVM,
  generateJSLibrariesImportString,
  getTreePathToDiskPath,
  nodeVMWithContext,
  RequestFile,
  RequestFiles
} from '@superblocksteam/shared-backend';
import cleanStack from './stack';

const sharedCode = `
module.exports = async function() {
  ${generateJSLibrariesImportString()}
  Object.entries($superblocksFiles).forEach(([treePath, diskPath]) => {
    const file = _.get(global, treePath);
    _.set(global, treePath, {
      ...file,
      $superblocksId: undefined,
      previewUrl: undefined,
      readContents: (mode) => {
        function serialize(buffer, mode) {
          if (mode === 'binary' || mode === 'text') {
            // utf8 encoding is lossy for truly binary data, but not an error in JS
            return buffer.toString(mode === 'binary' ? 'base64' : 'utf8');
          }
          // Otherwise, detect mode from first 1024 chars
          const chunk = buffer.slice(0, 1024).toString('utf8');
          if (chunk.indexOf('\u{FFFD}') > -1) {
            return buffer.toString('base64');
          }
          return buffer.toString('utf8');
        }

        function fetchFromControllerAsync(location, callback) {
          require('http').get($fileServerUrl + '?location=' + location, {
            headers: { 'x-superblocks-agent-key': $agentKey }
          }, (response) => {
            if (response.statusCode != 200) {
              return callback(null, new Error('Internal Server Error'));
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('error', (err) => callback(null, err));
            response.on('end', () => callback(Buffer.concat(chunks), null));
          })
        }

        // This function is a hack. It's required to remain compatible with
        // the synchronous contract we have with readContents.
        function fetchFromControllerSync(location) {
          let _response;
          let _err;
          fetchFromControllerAsync(location, (response, err) => {
            _response = response;
            _err = err;
          })
          while(_response === undefined || _err === undefined) {
            require('deasync').sleep(100);
          }
          if (_err) {
            throw _err
          }
          return _response;
        }

        let flagWorker = false
        try {
          if (($flagWorker == true)) {
            flagWorker = true
          }
        } catch (e) {
          if (!(e instanceof ReferenceError)) {
            throw e
          }
          // fallthrough otherwise
        }

        return serialize(flagWorker ? fetchFromControllerSync(diskPath) : fs.readFileSync(diskPath), mode)
      }
    });
  });

  var $augmentedConsole = (function(cons) {
    const logObject = (args) => {
      var outputs = [];
      for (arg of args) {
        try {
          outputs.push(JSON.stringify(arg, null, 2));
        } catch (err) {
          outputs.push(arg);
        }
      }
      cons.log(outputs.join('\\n'));
    };
    return {
        ...cons,
        log: function(...args) {
          logObject(args);
        },
        dir: function(...args) {
          logObject(args);
        }
    };
  }(console));
  console = $augmentedConsole;
`;

export type JavascriptProcessInput = {
  context: ExecutionContext;
  code: string;
  files?: RequestFiles;
  executionTimeout: number;
};

// This function runs the code in VM, it is called by worker pool in JavascriptPlugin.
export default async ({ context, code, files, executionTimeout }: JavascriptProcessInput): Promise<string> => {
  const ret = new ExecutionOutput();
  const filePaths = getTreePathToDiskPath(context.globals, files as Array<RequestFile>);
  const codeLineNumberOffset = sharedCode.split('\n').length;

  try {
    const vm = nodeVMWithContext(context, filePaths, executionTimeout);
    addLogListenersToVM(vm, ret);
    ret.output = await vm.run(
      `${sharedCode}
  ${code}
}()`,
      __dirname
    );
  } catch (err) {
    ret.error = cleanStack(err.stack, codeLineNumberOffset);
  }
  return JSON.stringify(ret);
};