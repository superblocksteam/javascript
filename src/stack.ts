const extractPathRegex = /\s+at.*[(\s](.*)\)?/;

export default function cleanStack(stack: string, lineOffset: number): string {
  const errorLines = stack.replace(/\\/g, '/').split('\n');

  // Find error line number
  let errorLineNumber: number = parseInt(errorLines[0].split(':').pop());

  const errorStack = errorLines
    .filter((line) => {
      const pathMatches = line.match(extractPathRegex);
      /*
       Some error stacks have the erroring line number set in a stack line after the error message.
       For example, ReferenceError stacks show up as the following, where the second line contains
       the erroring line number and character/column number at the end in that order:

       ReferenceError: y is not defined
          at ...:67:1
      */
      if (isNaN(errorLineNumber) && pathMatches) {
        const lineSplit = line.split(':');
        errorLineNumber = parseInt(lineSplit[lineSplit.length - 2]);
      }
      return !pathMatches && !line.startsWith('/');
    })
    .filter((line) => line.trim() !== '')
    .join('\n');

  return isNaN(errorLineNumber) ? errorStack : `Error on line ${errorLineNumber - lineOffset}:\n${errorStack}`;
}
