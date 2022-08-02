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

  function fetchFromController(location, callback) {
    require('http').get($fileServerUrl + '?location=' + location, {
      headers: { 'x-superblocks-agent-key': $agentKey }
    }, (response) => {
      if (response.statusCode != 200) {
        return callback(new Error('Internal Server Error'), null);
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('error', (err) => callback(err, null));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    })
  }

  Object.entries($superblocksFiles).forEach(([treePath, diskPath]) => {
    const file = _.get(global, treePath);
    _.set(global, treePath, {
      ...file,
      $superblocksId: undefined,
      previewUrl: undefined,
      readContentsAsync: async (mode) => serialize(await require('util').promisify(fetchFromController)(diskPath), mode),
      readContents: (mode) => serialize(require('deasync')(fetchFromController)(diskPath), mode)
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
