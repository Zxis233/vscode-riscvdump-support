"use strict";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { __test } = require("../src/extension");

function withOptions(overrides) {
  return {
    ...__test.DEFAULT_FORMAT_OPTIONS,
    ...overrides
  };
}

const fixedAddressOptions = withOptions({ addressWidth: 4 });

assert.strictEqual(
  __test.formatDisassembledLine("   0:\t00010117          \tauipc\tsp,0x10", fixedAddressOptions),
  "   0:   00010117           auipc    sp,0x10"
);

assert.strictEqual(
  __test.formatDisassembledLine("   4:\tf0010113          \taddi\tsp,sp,-256 # ff00 <_stack_top>", fixedAddressOptions),
  "   4:   f0010113           addi     sp,sp,-256              # ff00 <_stack_top>"
);

assert.strictEqual(
  __test.formatDisassembledLine(" 10:\t30529073          \tcsrw\tmtvec,t0", withOptions({ addressWidth: 4, spaceAfterComma: true })),
  "  10:   30529073           csrw     mtvec, t0"
);

assert.strictEqual(
  __test.formatDisassembledLine("  d0:\t005e2023          \tsw\tt0,0(t3)", withOptions({ addressWidth: 4, alignOperandFields: true })),
  "  d0:   005e2023           sw       t0,   0(t3)"
);

assert.strictEqual(
  __test.formatDisassembledLine(
    " 100:\t00e50533          \tadd\ta0,a1,a2",
    withOptions({
      addressWidth: 4,
      alignOperandFields: true,
      operandFieldWidths: [8, 10, 8]
    })
  ),
  " 100:   00e50533           add      a0,     a1,       a2"
);

assert.strictEqual(
  __test.formatDisassembledLine("00000000 <_start>:"),
  "00000000 <_start>:"
);

assert.strictEqual(
  __test.splitOperands("t1,t3,14c <jop_fail_bad_cause>").join("|"),
  "t1|t3|14c <jop_fail_bad_cause>"
);

assert.strictEqual(
  __test.formatText("Disassembly of section .text:\n 100:\t00008067          \tret\n"),
  "Disassembly of section .text:\n 100:   00008067           ret\n"
);

assert.strictEqual(
  __test.formatText("0:\t00010117          \tauipc\tsp,0x10\n10000:\t00008067          \tret"),
  "    0:  00010117           auipc    sp,0x10\n10000:  00008067           ret"
);

assert.strictEqual(
  __test.formatDisassembledLine("   4:\tf0010113          \taddi\tsp,sp,-256 #ff00   <_stack_top>", fixedAddressOptions),
  "   4:   f0010113           addi     sp,sp,-256              #ff00   <_stack_top>"
);

console.log("formatter tests OK");
