// Help for the language: one entry for each command and each kind of expression
// "help" lists them all, with the tools. "help <word>" shows one entry, with examples.
// test/help.test.js checks that every example parses.

// where: "AGENTS.talk" means the example only parses in AGENTS.talk
export const HELP = [
  // ----- commands -----
  {
    name: "print", kind: "command",
    syntax: "print <value>",
    description: "Output a value to the agent. A list of lines prints one line each, with its number.",
    examples: ["print 'hello'", "print lines 1 to 5 of ./README.md"],
  },
  {
    name: "set", kind: "command",
    syntax: "set <variable or property> to <value>",
    description: "Set a variable, a property, or the result. A plain name is local to the script or tool. A $name is a global that stays between runs.",
    examples: ["set total to 0", "set config's version to 2", "set $last to 'build ok'", "set the result to 'done'"],
  },
  {
    name: "increment", kind: "command",
    syntax: "increment <variable or property> [by <number>]",
    description: "Add to a number. With no 'by', add 1. A variable that is not set starts at 0.",
    examples: ["increment total by item's price", "increment count"],
  },
  {
    name: "decrement", kind: "command",
    syntax: "decrement <variable or property> [by <number>]",
    description: "Take away from a number. With no 'by', take away 1.",
    examples: ["decrement retries"],
  },
  {
    name: "if", kind: "command",
    syntax: "if <condition> ... [else if <condition> ...] [else ...] end",
    description: "Run commands when a condition is true. One 'end' closes the whole chain.",
    examples: ["if count > 10\n  print 'many'\nelse if count > 0\n  print 'some'\nelse\n  print 'none'\nend"],
  },
  {
    name: "for", kind: "command",
    syntax: "for <name> in <list> [index <name>] ... end",
    description: "Run commands for each item of a list: a list of files, lines, or values. The index starts at 0.",
    examples: ["for file in ./src/**/*.js\n  print file's path\nend", "for line in lines of the result's output index i\n  print line\nend"],
  },
  {
    name: "repeat", kind: "command",
    syntax: "repeat <n> times ... end | repeat while <condition> ... end | repeat until <condition> ... end",
    description: "Run commands again and again. Each pass counts against the step budget.",
    examples: ["repeat 3 times index i\n  print i\nend", "repeat until done\n  set done to true\nend"],
  },
  {
    name: "break", kind: "command",
    syntax: "break",
    description: "Leave the loop now.",
    examples: ["for x in [1, 2, 3]\n  if x is 2 break end\n  print x\nend"],
  },
  {
    name: "continue", kind: "command",
    syntax: "continue",
    description: "In a loop: go on with the next pass. In 'on error': go on with the command after the one that failed.",
    examples: ["for x in [1, 2, 3]\n  if x is 2 continue end\n  print x\nend"],
  },
  {
    name: "on error", kind: "command",
    syntax: "on error ... [continue | stop] end",
    description: "Handle errors anywhere in the script or tool. 'the error' has message, line and column. 'continue' goes on after the failed command. 'stop' (the default) ends with the error.",
    examples: ["read ./missing.txt\non error\n  print 'could not read: ' + the error's message\n  continue\nend"],
  },
  {
    name: "stop", kind: "command",
    syntax: "stop",
    description: "In 'on error': end the script or tool with the error.",
    examples: ["on error\n  print 'giving up'\n  stop\nend"],
  },
  {
    name: "read", kind: "command",
    syntax: "read <file>",
    description: "Put the text of a file in the result. Also an expression: set x to read <file>.",
    examples: ["read @/README.md\nprint it", "set readme to read @/README.md"],
  },
  {
    name: "write", kind: "command",
    syntax: "write <value> to <file>",
    description: "Replace the text of a file, or make it. Fails if the file changed since this script read it.",
    examples: ["write 'hello' to ./out.txt", "write config as pretty json to ./config.json"],
  },
  {
    name: "append", kind: "command",
    syntax: "append <value> to <file>",
    description: "Add text to the end of a file, or make it.",
    examples: ["append 'one more line\\n' to ./log.txt"],
  },
  {
    name: "replace", kind: "command",
    syntax: "replace <old> with <new> in <file or variable> | replace lines <a> to <b> of <file> with <text>",
    description: "Replace every match of the old text. The result lists each replacement, so 'if the result is empty' means no match. No match also gives a warning. Or replace lines by number: that needs a read of the file first, and the result is the old lines.",
    examples: ["replace 'var ' with 'let ' in ./src/app.js", "read ./a.js\nreplace lines 2 to 3 of ./a.js with 'let x = 1'"],
  },
  {
    name: "find", kind: "command",
    syntax: "find <text> in <file, list of files, or text>",
    description: "Put the lines that contain the text in the result. Each line has number and text, and file when it comes from a file. print shows path:number: text. The match is plain text, and letter case counts.",
    examples: ["find 'TODO' in ./src/**/*.js\nprint the result", "find 'FAIL' in the result's output\nif the result is empty print 'all good' end"],
  },
  {
    name: "put", kind: "command",
    syntax: "put <text> before line <n> of <file> | put <text> after line <n> of <file>",
    description: "Put new lines into a file. Needs a read of the file first. Line numbers shift after an edit.",
    examples: ["read ./a.js\nput '// top' before line 1 of ./a.js"],
  },
  {
    name: "remove", kind: "command",
    syntax: "remove lines <a> to <b> of <file>",
    description: "Remove lines from a file. Needs a read of the file first. The result is the old lines.",
    examples: ["read ./a.js\nremove lines 5 to 7 of ./a.js"],
  },
  {
    name: "help", kind: "command",
    syntax: "help [<word>]",
    description: "List the language and the tools, or show one of them with examples. The word must be on the same line as 'help'.",
    examples: ["help", "help replace", "help on error"],
  },
  {
    name: "then", kind: "command",
    syntax: "<command> then <command>",
    description: "Separate commands on one line. A line end does not end a command.",
    examples: ["set x to 1 then print x"],
  },
  {
    name: "tool", kind: "command", where: "AGENTS.talk",
    syntax: "tool <name> [with <param>, ...] ... end",
    description: "Only in AGENTS.talk. Define a tool the agent can call by name. The '#' comment lines just above it are its help. The tool gives back the result.",
    examples: ["# Runs one test class.\ntool run_test with name\n  run 'mvn' with 'test', '-Dtest=' + name\nend"],
  },
  {
    name: "run", kind: "command", where: "AGENTS.talk",
    syntax: "run <program and args> | run <program> with <arg>, ... [within <duration>]",
    description: "Only in a tool. Run a program with no shell. Gives back { code, output }. Only the variables from 'allow env' are passed on.",
    examples: ["tool test\n  run 'npm test' within 10 minutes\nend"],
  },
  {
    name: "import", kind: "command", where: "AGENTS.talk",
    syntax: "import <path to a .talk file>",
    description: "Only in AGENTS.talk and the files it imports. Load the tools from another .talk file. ./ starts from the importing file, @/ from the project root.",
    examples: ["import ./talk/git.talk", "import @/talk/maven.talk"],
  },
  {
    name: "before", kind: "command", where: "AGENTS.talk",
    syntax: "before <step> ... end",
    description: "Only in AGENTS.talk. Run commands before a step: read, write, append, replace, put, remove, change (any file change), run, or a tool name. 'the <step>' holds the step. 'reject' stops the step.",
    examples: ["before change\n  if the change's path ends with '.env'\n    reject 'Cannot change env files!'\n  end\nend"],
  },
  {
    name: "after", kind: "command", where: "AGENTS.talk",
    syntax: "after <step> ... end",
    description: "Only in AGENTS.talk. Run commands after a step. 'the <step>' holds the step, and 'the result' holds what it gave back.",
    examples: ["after run\n  print 'ran ' + the run's program + ': ' + the result's code\nend"],
  },
  {
    name: "reject", kind: "command", where: "AGENTS.talk",
    syntax: "reject <message>",
    description: "Only in a 'before' hook. The step does not happen, and the script gets an error with the message. 'on error' can catch it.",
    examples: ["before write\n  reject 'This project is read only'\nend"],
  },
  {
    name: "git", kind: "command",
    syntax: "git status | git diff [<files>] | git log [<count>] | git show <commit> | git branches | git branch",
    description: "A hardened git: no hooks, no pager, no external diff, and a clean environment. The result is git's output as text. If the repo config can run programs, git does not run. Status is short, with the branch. Log shows 15 commits, one line each.",
    examples: ["git status\nprint it", "git diff ./src/app.js\nprint it", "git log 5\nprint it"],
  },
  {
    name: "allow", kind: "command", where: "AGENTS.talk",
    syntax: "allow env <NAME>, ... | allow changes to <path>, ...",
    description: "Only at the top of AGENTS.talk. 'allow env' lists the environment variables that 'run' passes on. 'allow changes to' lists hidden files and folders (names that start with .) that scripts can change. A folder allows all of its files.",
    examples: ["allow env PATH, HOME", "allow changes to @/.github/, @/.gitignore"],
  },

  // ----- expressions -----
  {
    name: "values", kind: "expression",
    syntax: "'text'  \"text\"  12  3.5  true  false  null  [1, 2]  {name: 'x'}",
    description: "Text, numbers, true, false, null, lists and objects. Numbers can use _ to group digits: 1_000.",
    examples: ["set item to {name: 'x', tags: ['a', 'b']}"],
  },
  {
    name: "strings", kind: "expression",
    syntax: "'text'  \"text\"  'Hi ${name}'  \"\"\" raw \"\"\"",
    description: "Both quotes work and can span lines; their common indent is removed. ${...} puts in a value (write \\${ for a plain one). A raw string in triple double quotes has no escapes and no ${}, and keeps its indent: use it for code.",
    examples: ["print 'Hi ${name}'", "set code to \"\"\"\n  const x = `${y}`\n\"\"\""],
  },
  {
    name: "paths", kind: "expression",
    syntax: "./x  ../x  @/x  ./src/**/*.js  ./\"my file.txt\"",
    description: "./ and ../ start from the current folder, @/ from the project root. * and ** make a list of files, sorted by path, and skip node_modules and .git unless the pattern names them. A file has name, path, text, lines, size and modified. Paths outside the project are refused.",
    examples: ["print ./src/**/*.js", "print the size of @/README.md"],
  },
  {
    name: "the", kind: "expression",
    syntax: "the <value>",
    description: "'the' is optional, and changes nothing. Use it where it reads better. To use a command word as a name, write 'the' before it: the write's path.",
    examples: ["print the file's text"],
  },
  {
    name: "it", kind: "expression",
    syntax: "it | the result",
    description: "The value from the last command: read, fetch, replace, a tool call, and more.",
    examples: ["read ./a.txt\nprint it"],
  },
  {
    name: "of", kind: "expression",
    syntax: "<value>'s <name> | <value>.<name> | <name> of <value> | <value>[<index>]",
    description: "Three ways to get a property: file's text, file.text and text of file are the same. A missing property is null.",
    examples: ["print the name of the file", "print config.version", "print items[0]"],
  },
  {
    name: "lines", kind: "expression",
    syntax: "lines of <file or text> | lines <a> to <b> of <file or text>",
    description: "The lines of a file or text. Each line has number (from 1) and text. A range uses line numbers, both ends included.",
    examples: ["for line in lines of the result's output\n  if line starts with 'FAIL' print line end\nend", "print lines 10 to 20 of ./a.js"],
  },
  {
    name: "first", kind: "expression",
    syntax: "first of <list, file or text>",
    description: "The first item of a list. For a file or text, the first line. An empty list gives null.",
    examples: ["print first of ./src/*.js", "print the first of ./README.md"],
  },
  {
    name: "last", kind: "expression",
    syntax: "last of <list, file or text>",
    description: "The last item of a list. For a file or text, the last line. An empty list gives null.",
    examples: ["print last of lines of the result's output", "print the number of the last of ./a.js"],
  },
  {
    name: "operators", kind: "expression",
    syntax: "+ - * / mod   is  is not  <  >  <=  >=   and  or  not  no",
    description: "Math, comparison and logic. Mixing different math operators, or 'and' with 'or', needs parentheses. + joins text. 'no x' is true for null and empty values.",
    examples: ["print 1 + (2 * 3)", "if a is 1 and b is not 2 print 'yes' end"],
  },
  {
    name: "contains", kind: "expression",
    syntax: "contains  does not contain  starts with  ends with  is in  is not in  exists  does not exist  is empty  is not empty",
    description: "Checks for text, lists and files. On a file or line they use its text.",
    examples: ["if the file contains 'TODO' print the file's path end"],
  },
  {
    name: "as", kind: "expression",
    syntax: "<value> as json | as pretty json | as number | as text",
    description: "Convert a value. 'as json' parses text, and formats other values as compact JSON.",
    examples: ["set config to the file's text as json"],
  },
  {
    name: "within", kind: "expression",
    syntax: "<tool call> within <duration>",
    description: "A time limit for a tool call. Durations: 100ms, 2s, 5 seconds, 10 minutes, 1 hour.",
    examples: ["help within"],
  },
];

// the entry for a word: a full name, or the first word of a name
function findEntry(word) {
  for (const entry of HELP) {
    if (entry.name === word || entry.name.split(" ")[0] === word) {
      return entry;
    }
  }
  return null;
}

// the first sentence of a text
function firstSentence(text) {
  const end = text.indexOf(". ");
  if (end === -1) {
    return text;
  }
  return text.slice(0, end + 1);
}

function pad(text, width) {
  while (text.length < width) {
    text += " ";
  }
  return text;
}

function toolSyntax(tool) {
  if (tool.params.length === 0) {
    return tool.name;
  }
  return tool.name + " with " + tool.params.join(", ");
}

/**
 * Everything, in short: commands, expressions, and the tools.
 * @param {{ name: string, params: string[], description: string }[]} tools
 */
export function helpIndex(tools, only) {
  const lines = [];
  if (!only || only === "commands") {
    lines.push("Commands:");
    for (const entry of HELP) {
      if (entry.kind === "command") {
        lines.push("  " + pad(entry.name, 12) + firstSentence(entry.description));
      }
    }
    lines.push("");
  }
  if (!only || only === "expressions") {
    lines.push("Expressions:");
    for (const entry of HELP) {
      if (entry.kind === "expression") {
        lines.push("  " + pad(entry.name, 12) + firstSentence(entry.description));
      }
    }
    lines.push("");
  }
  if ((!only || only === "tools") && tools.length === 0) {
    lines.push("Tools: none. A human can add tools in AGENTS.talk.", "");
  }
  if ((!only || only === "tools") && tools.length > 0) {
    lines.push("Tools:");
    for (const tool of tools) {
      const description = tool.description ? tool.description.split("\n")[0] : "";
      lines.push("  " + pad(toolSyntax(tool), 24) + description);
    }
    lines.push("");
  }
  lines.push("Use help <word> for details and examples, for example: help replace");
  lines.push("Use help commands, help expressions or help tools for one group.");
  return lines.join("\n");
}

/**
 * One command, expression or tool, with examples. Null if the word is not known.
 */
export function helpFor(word, tools) {
  if (word === "commands" || word === "expressions" || word === "tools") {
    return helpIndex(tools, word);
  }
  for (const tool of tools) {
    if (tool.name === word) {
      const lines = [toolSyntax(tool), "A tool. Call it by name, with arguments by position or with name: value."];
      if (tool.description) {
        lines.push("", tool.description);
      }
      return lines.join("\n");
    }
  }
  const entry = findEntry(word);
  if (entry === null) {
    return null;
  }
  const lines = [entry.syntax, "", entry.description, "", "Examples:"];
  for (const example of entry.examples) {
    lines.push("");
    for (const line of example.split("\n")) {
      lines.push("  " + line);
    }
  }
  return lines.join("\n");
}
