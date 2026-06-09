"use strict";

const vscode = require("vscode");

const LANGUAGE_ID = "riscv-dump-asm";
const SECTION_RE = /^Disassembly of section\s+([^:]+):/;
const LABEL_RE = /^\s*([0-9A-Fa-f]+)\s+<([^>]+)>:/;
const INSTRUCTION_RE = /^\s*([0-9A-Fa-f]+):\s+([0-9A-Fa-f]{4,16})\s+([A-Za-z.][\w.]*)(.*)$/;
const DISASSEMBLED_LINE_RE = /^(\s*)([0-9A-Fa-f]+):\s*([0-9A-Fa-f]{4,16})(?:\s+(.*?))?\s*$/;

const DEFAULT_FORMAT_OPTIONS = Object.freeze({
  enabled: true,
  alignAddresses: true,
  addressWidth: "auto",
  alignMachineCode: true,
  machineCodeColumn: 8,
  alignMnemonics: true,
  mnemonicColumn: 27,
  alignOperands: true,
  operandsColumn: 36,
  alignComments: true,
  commentColumn: 60,
  spaceAfterComma: false,
  alignOperandFields: false,
  operandFieldWidth: 6,
  operandFieldWidths: []
});

const REGISTER_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "fp", "pc",
  "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7",
  "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
  "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
  "x24", "x25", "x26", "x27", "x28", "x29", "x30", "x31",
  "t0", "t1", "t2", "t3", "t4", "t5", "t6",
  "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11",
  "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"
];

const CSR_NAMES = [
  "cycle", "time", "instret", "fflags", "frm", "fcsr",
  "mvendorid", "marchid", "mimpid", "mhartid", "mstatus", "misa", "medeleg",
  "mideleg", "mie", "mtvec", "mcounteren", "mscratch", "mepc", "mcause",
  "mtval", "mip", "mtinst", "mtval2", "sstatus", "sie", "stvec",
  "scounteren", "sscratch", "sepc", "scause", "stval", "sip", "satp",
  "ssp", "ustatus", "uie", "utvec", "uscratch", "uepc", "ucause", "utval", "uip"
];

const INSTRUCTION_NAMES = [
  "add", "addi", "addiw", "addw", "and", "andi", "auipc", "beq", "beqz", "bge",
  "bgeu", "bgez", "bgt", "bgtu", "bgtz", "ble", "bleu", "blez", "blt", "bltu",
  "bltz", "bne", "bnez", "call", "csrc", "csrci", "csrr", "csrrc", "csrrci",
  "csrrs", "csrrsi", "csrrw", "csrrwi", "csrs", "csrsi", "csrw", "csrwi",
  "div", "divu", "divuw", "divw", "ebreak", "ecall", "fence", "fence.i", "j",
  "jal", "jalr", "jr", "lb", "lbu", "ld", "lh", "lhu", "li", "lpad", "lui",
  "lw", "lwu", "mret", "mul", "mulh", "mulhsu", "mulhu", "mulw", "mv", "neg",
  "nop", "not", "or", "ori", "rem", "remu", "remuw", "remw", "ret", "sb", "sd",
  "sext.b", "sext.h", "sext.w", "sll", "slli", "slliw", "sllw", "slt", "slti",
  "sltiu", "sltu", "sra", "srai", "sraiw", "sraw", "sret", "srl", "srli",
  "srliw", "srlw", "sub", "subw", "sw", "tail", "wfi", "xor", "xori", "zext.b",
  "zext.h", "zext.w"
];

function activate(context) {
  const selector = { language: LANGUAGE_ID, scheme: "file" };

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, new RiscvDumpSymbolProvider()),
    vscode.languages.registerDefinitionProvider(selector, new RiscvDumpDefinitionProvider()),
    vscode.languages.registerHoverProvider(selector, new RiscvDumpHoverProvider()),
    vscode.languages.registerDocumentFormattingEditProvider(selector, new RiscvDumpFormattingProvider()),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, new RiscvDumpFormattingProvider()),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new RiscvDumpCompletionProvider(),
      ".", "x", "a", "s", "t", "m", "c"
    )
  );
}

function deactivate() {}

class RiscvDumpSymbolProvider {
  provideDocumentSymbols(document) {
    const structure = parseDocumentStructure(document);
    const symbols = [];

    for (const label of structure.looseLabels) {
      const next = nextLineAfter(label.line, structure.events, document.lineCount - 1);
      symbols.push(createLabelSymbol(document, label, next));
    }

    structure.sections.forEach((section, index) => {
      const sectionEnd = index + 1 < structure.sections.length
        ? structure.sections[index + 1].line - 1
        : document.lineCount - 1;
      const symbol = new vscode.DocumentSymbol(
        section.name,
        "disassembly section",
        vscode.SymbolKind.Namespace,
        makeRange(document, section.line, sectionEnd),
        makeSelectionRange(document, section.line, section.name)
      );

      section.labels.forEach((label, labelIndex) => {
        const labelEnd = labelIndex + 1 < section.labels.length
          ? section.labels[labelIndex + 1].line - 1
          : sectionEnd;
        symbol.children.push(createLabelSymbol(document, label, labelEnd));
      });

      symbols.push(symbol);
    });

    return symbols;
  }
}

class RiscvDumpDefinitionProvider {
  provideDefinition(document, position) {
    const reference = getSymbolReferenceAtPosition(document, position);
    if (!reference) {
      return undefined;
    }

    const labels = buildLabelIndex(document);
    const target = labels.get(normalizeSymbolName(reference.name));
    return target ? target.location : undefined;
  }
}

class RiscvDumpHoverProvider {
  provideHover(document, position) {
    const reference = getSymbolReferenceAtPosition(document, position);
    if (reference) {
      const target = buildLabelIndex(document).get(normalizeSymbolName(reference.name));
      if (target) {
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.appendMarkdown(`**${target.name}**\n\nAddress: \`0x${target.address}\``);
        return new vscode.Hover(markdown, reference.range);
      }
    }

    const instruction = parseInstructionLine(document.lineAt(position.line).text);
    if (!instruction) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`Address: \`0x${instruction.address}\`\n\n`);
    markdown.appendMarkdown(`Machine code: \`0x${instruction.machineCode}\`\n\n`);
    markdown.appendMarkdown(`Instruction: \`${instruction.mnemonic}${instruction.operands}\``);
    return new vscode.Hover(markdown);
  }
}

class RiscvDumpCompletionProvider {
  provideCompletionItems(document, position) {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (linePrefix.includes("#")) {
      return undefined;
    }

    return [
      ...INSTRUCTION_NAMES.map((name) => completion(name, vscode.CompletionItemKind.Function, "RISC-V instruction")),
      ...REGISTER_NAMES.map((name) => completion(name, vscode.CompletionItemKind.Variable, "RISC-V register")),
      ...CSR_NAMES.map((name) => completion(name, vscode.CompletionItemKind.Constant, "RISC-V CSR"))
    ];
  }
}

class RiscvDumpFormattingProvider {
  provideDocumentFormattingEdits(document) {
    return createFormattingEdits(document, fullDocumentRange(document));
  }

  provideDocumentRangeFormattingEdits(document, range) {
    const lineRange = wholeLineRange(document, range);
    return createFormattingEdits(document, lineRange);
  }
}

function completion(label, kind, detail) {
  const item = new vscode.CompletionItem(label, kind);
  item.detail = detail;
  return item;
}

function parseDocumentStructure(document) {
  const sections = [];
  const looseLabels = [];
  const events = [];
  let currentSection = undefined;

  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const sectionMatch = text.match(SECTION_RE);
    if (sectionMatch) {
      currentSection = {
        name: sectionMatch[1],
        line,
        labels: []
      };
      sections.push(currentSection);
      events.push(line);
      continue;
    }

    const labelMatch = text.match(LABEL_RE);
    if (labelMatch) {
      const label = {
        address: labelMatch[1],
        name: labelMatch[2],
        line
      };

      if (currentSection) {
        currentSection.labels.push(label);
      } else {
        looseLabels.push(label);
      }
      events.push(line);
    }
  }

  return { sections, looseLabels, events };
}

function buildLabelIndex(document) {
  const labels = new Map();

  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = text.match(LABEL_RE);
    if (!match) {
      continue;
    }

    const name = match[2];
    if (labels.has(name)) {
      continue;
    }

    labels.set(name, {
      name,
      address: match[1],
      location: new vscode.Location(document.uri, makeSelectionRange(document, line, name))
    });
  }

  return labels;
}

function createLabelSymbol(document, label, endLine) {
  return new vscode.DocumentSymbol(
    label.name,
    `0x${label.address}`,
    vscode.SymbolKind.Function,
    makeRange(document, label.line, endLine),
    makeSelectionRange(document, label.line, label.name)
  );
}

function makeRange(document, startLine, endLine) {
  const safeStart = clampLine(document, startLine);
  const safeEnd = Math.max(safeStart, clampLine(document, endLine));
  return new vscode.Range(
    safeStart,
    0,
    safeEnd,
    document.lineAt(safeEnd).text.length
  );
}

function makeSelectionRange(document, line, text) {
  const safeLine = clampLine(document, line);
  const lineText = document.lineAt(safeLine).text;
  const start = Math.max(0, lineText.indexOf(text));
  return new vscode.Range(safeLine, start, safeLine, start + text.length);
}

function clampLine(document, line) {
  return Math.max(0, Math.min(line, document.lineCount - 1));
}

function nextLineAfter(line, events, fallback) {
  const next = events.find((eventLine) => eventLine > line);
  return next === undefined ? fallback : next - 1;
}

function getSymbolReferenceAtPosition(document, position) {
  const text = document.lineAt(position.line).text;
  const angleReference = /<([^>]+)>/g;
  let match;

  while ((match = angleReference.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        name: match[1],
        range: new vscode.Range(position.line, start, position.line, end)
      };
    }
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_.$][\w.$]*/);
  if (!wordRange) {
    return undefined;
  }

  const name = document.getText(wordRange);
  return { name, range: wordRange };
}

function normalizeSymbolName(name) {
  return name.trim().replace(/[+-](?:0x[0-9A-Fa-f]+|\d+)$/, "");
}

function parseInstructionLine(text) {
  const match = text.match(INSTRUCTION_RE);
  if (!match) {
    return undefined;
  }

  return {
    address: match[1],
    machineCode: match[2],
    mnemonic: match[3],
    operands: match[4] || ""
  };
}

function createFormattingEdits(document, range) {
  const options = getFormatterOptions(document);
  if (!options.enabled) {
    return [];
  }

  const original = document.getText(range);
  const formatted = formatText(original, options, getDocumentEol(document));
  if (original === formatted) {
    return [];
  }

  return [vscode.TextEdit.replace(range, formatted)];
}

function getFormatterOptions(document) {
  const config = vscode.workspace.getConfiguration("riscvDumpAsm", document.uri);
  return {
    enabled: config.get("format.enabled", DEFAULT_FORMAT_OPTIONS.enabled),
    alignAddresses: config.get("format.alignAddresses", DEFAULT_FORMAT_OPTIONS.alignAddresses),
    addressWidth: getNumberOrKeyword(
      config.get("format.addressWidth", DEFAULT_FORMAT_OPTIONS.addressWidth),
      "auto",
      1,
      32
    ),
    alignMachineCode: config.get("format.alignMachineCode", DEFAULT_FORMAT_OPTIONS.alignMachineCode),
    machineCodeColumn: clampNumber(config.get("format.machineCodeColumn", DEFAULT_FORMAT_OPTIONS.machineCodeColumn), 0, 120),
    alignMnemonics: config.get("format.alignMnemonics", DEFAULT_FORMAT_OPTIONS.alignMnemonics),
    mnemonicColumn: clampNumber(config.get("format.mnemonicColumn", DEFAULT_FORMAT_OPTIONS.mnemonicColumn), 0, 160),
    alignOperands: config.get("format.alignOperands", DEFAULT_FORMAT_OPTIONS.alignOperands),
    operandsColumn: clampNumber(config.get("format.operandsColumn", DEFAULT_FORMAT_OPTIONS.operandsColumn), 0, 180),
    alignComments: config.get("format.alignComments", DEFAULT_FORMAT_OPTIONS.alignComments),
    commentColumn: getNumberOrKeyword(
      config.get("format.commentColumn", DEFAULT_FORMAT_OPTIONS.commentColumn),
      "preserve",
      0,
      240
    ),
    spaceAfterComma: config.get("format.spaceAfterComma", DEFAULT_FORMAT_OPTIONS.spaceAfterComma),
    alignOperandFields: config.get("format.alignOperandFields", DEFAULT_FORMAT_OPTIONS.alignOperandFields),
    operandFieldWidth: clampNumber(config.get("format.operandFieldWidth", DEFAULT_FORMAT_OPTIONS.operandFieldWidth), 1, 40),
    operandFieldWidths: clampNumberArray(
      config.get("format.operandFieldWidths", DEFAULT_FORMAT_OPTIONS.operandFieldWidths),
      1,
      80
    )
  };
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function getNumberOrKeyword(value, keyword, min, max) {
  if (value === keyword) {
    return keyword;
  }
  return clampNumber(value, min, max);
}

function clampNumberArray(value, min, max) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.max(min, Math.min(max, Math.trunc(item))));
}

function fullDocumentRange(document) {
  const lastLine = document.lineCount - 1;
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
}

function wholeLineRange(document, range) {
  const startLine = clampLine(document, range.start.line);
  const endLine = clampLine(document, range.end.line);
  return new vscode.Range(
    startLine,
    0,
    endLine,
    document.lineAt(endLine).text.length
  );
}

function getDocumentEol(document) {
  if (document.eol === vscode.EndOfLine.CRLF) {
    return "\r\n";
  }
  return "\n";
}

function formatText(text, options = DEFAULT_FORMAT_OPTIONS, preferredEol) {
  const eol = detectEol(text, preferredEol);
  const lines = text.split(/\r\n|\n/);
  const resolvedOptions = resolveAutoFormatOptions(lines, options);
  return lines.map((line) => formatDisassembledLine(line, resolvedOptions)).join(eol);
}

function detectEol(text, preferredEol = "\n") {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  if (crlf === 0 && lf === 0) {
    return preferredEol;
  }
  return crlf >= lf ? "\r\n" : "\n";
}

function formatDisassembledLine(line, options = DEFAULT_FORMAT_OPTIONS) {
  const parsed = parseDisassembledLine(line);
  if (!parsed) {
    return line;
  }

  let output = options.alignAddresses
    ? `${parsed.address.padStart(Math.max(resolveAddressWidth(options), parsed.address.length))}:`
    : `${parsed.leading}${parsed.address}:`;

  output = appendColumn(output, parsed.machineCode, options.machineCodeColumn, options.alignMachineCode);

  if (parsed.mnemonic) {
    output = appendColumn(output, parsed.mnemonic, options.mnemonicColumn, options.alignMnemonics);
  }

  if (parsed.operands) {
    output = appendColumn(
      output,
      formatOperands(parsed.operands, options),
      options.operandsColumn,
      options.alignOperands
    );
  }

  if (parsed.comment) {
    output = appendComment(output, parsed.comment, options);
  }

  return output.trimEnd();
}

function resolveAutoFormatOptions(lines, options) {
  if (options.addressWidth !== "auto") {
    return options;
  }

  let addressWidth = 4;
  for (const line of lines) {
    const parsed = parseDisassembledLine(line);
    if (parsed) {
      addressWidth = Math.max(addressWidth, parsed.address.length);
    }
  }

  return {
    ...options,
    addressWidth
  };
}

function resolveAddressWidth(options) {
  return options.addressWidth === "auto" ? 4 : options.addressWidth;
}

function parseDisassembledLine(line) {
  const match = line.match(DISASSEMBLED_LINE_RE);
  if (!match) {
    return undefined;
  }

  const [, leading, address, machineCode, body = ""] = match;
  const split = splitComment(body);
  const code = split.code.trim();

  if (!code) {
    return {
      leading,
      address,
      machineCode,
      mnemonic: "",
      operands: "",
      comment: split.comment
    };
  }

  const codeMatch = code.match(/^([A-Za-z.][\w.]*)(?:\s+(.*))?$/);
  if (!codeMatch) {
    return undefined;
  }

  return {
    leading,
    address,
    machineCode,
    mnemonic: codeMatch[1],
    operands: (codeMatch[2] || "").trim(),
    comment: split.comment
  };
}

function splitComment(text) {
  const index = text.indexOf("#");
  if (index === -1) {
    return { code: text, comment: "" };
  }

  const code = text.slice(0, index);
  return {
    code,
    comment: text.slice(index).trimEnd()
  };
}

function appendColumn(current, value, column, enabled) {
  if (!value) {
    return current;
  }

  if (!enabled) {
    return `${current} ${value}`;
  }

  const spaces = Math.max(1, column - current.length);
  return `${current}${" ".repeat(spaces)}${value}`;
}

function appendComment(current, comment, options) {
  if (options.commentColumn === "preserve") {
    return `${current} ${comment}`;
  }

  return appendColumn(current, comment, options.commentColumn, options.alignComments);
}

function formatOperands(operands, options) {
  const parts = splitOperands(operands);
  if (parts.length <= 1) {
    return operands.trim();
  }

  if (options.alignOperandFields) {
    return alignOperandFields(parts, getOperandFieldWidths(options));
  }

  return parts.join(options.spaceAfterComma ? ", " : ",");
}

function getOperandFieldWidths(options) {
  if (Array.isArray(options.operandFieldWidths) && options.operandFieldWidths.length > 0) {
    return options.operandFieldWidths;
  }

  return [options.operandFieldWidth];
}

function splitOperands(operands) {
  const parts = [];
  let current = "";
  let parenDepth = 0;
  let angleDepth = 0;

  for (const char of operands) {
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (char === "<") {
      angleDepth += 1;
    } else if (char === ">" && angleDepth > 0) {
      angleDepth -= 1;
    }

    if (char === "," && parenDepth === 0 && angleDepth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

function alignOperandFields(parts, fieldWidths) {
  let output = parts[0];
  let column = output.length;
  let target = 0;

  for (let index = 1; index < parts.length; index++) {
    output += ",";
    column += 1;

    target += getOperandFieldWidth(fieldWidths, index - 1);
    const spaces = Math.max(1, target - column);
    output += `${" ".repeat(spaces)}${parts[index]}`;
    column += spaces + parts[index].length;
  }

  return output;
}

function getOperandFieldWidth(fieldWidths, index) {
  if (typeof fieldWidths === "number") {
    return fieldWidths;
  }

  if (!Array.isArray(fieldWidths) || fieldWidths.length === 0) {
    return DEFAULT_FORMAT_OPTIONS.operandFieldWidth;
  }

  return fieldWidths[Math.min(index, fieldWidths.length - 1)];
}

module.exports = {
  activate,
  deactivate,
  __test: {
    DEFAULT_FORMAT_OPTIONS,
    formatText,
    formatDisassembledLine,
    parseDisassembledLine,
    splitOperands
  }
};
