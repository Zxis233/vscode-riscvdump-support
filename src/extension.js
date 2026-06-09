"use strict";

const vscode = require("vscode");

const LANGUAGE_ID = "riscv-dump-asm";
const SECTION_RE = /^Disassembly of section\s+([^:]+):/;
const LABEL_RE = /^\s*([0-9A-Fa-f]+)\s+<([^>]+)>:/;
const INSTRUCTION_RE = /^\s*([0-9A-Fa-f]+):\s+([0-9A-Fa-f]{4,16})\s+([A-Za-z.][\w.]*)(.*)$/;

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

module.exports = {
  activate,
  deactivate
};
