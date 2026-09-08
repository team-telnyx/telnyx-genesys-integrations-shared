import {
  checkbox as inquirerCheckbox,
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
  select as inquirerSelect,
} from "@inquirer/prompts";
import chalk from "chalk";

export const color = Object.freeze({
  title: (value) => chalk.bold.cyan(value),
  subtitle: (value) => chalk.gray(value),
  success: (value) => chalk.green(value),
  warning: (value) => chalk.yellow(value),
  danger: (value) => chalk.red(value),
  muted: (value) => chalk.gray(value),
  accent: (value) => chalk.cyan(value),
  bold: (value) => chalk.bold(value),
});

export function header(title, subtitle = "") {
  const width = Math.max(64, title.length + 6, subtitle.length + 6);
  const line = "═".repeat(width - 2);
  console.log(chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan("║ ") + chalk.bold.white(title.padEnd(width - 4)) + chalk.cyan(" ║"));
  if (subtitle) {
    console.log(chalk.cyan("║ ") + chalk.gray(subtitle.padEnd(width - 4)) + chalk.cyan(" ║"));
  }
  console.log(chalk.cyan(`╚${line}╝`));
}

function promptChoices(options) {
  return options.map((entry) => ({
    name: entry.label,
    value: entry.value,
    description: entry.description,
    disabled: entry.disabled,
    checked: entry.checked,
  }));
}

export function selectMenu(message, options, { pageSize = 12 } = {}) {
  if (!options.length) throw new Error(`No options available for ${message}`);
  return inquirerSelect({
    message,
    choices: promptChoices(options),
    pageSize: Math.min(Math.max(pageSize, 7), 20),
    loop: false,
  });
}

export function checkboxMenu(message, options, { pageSize = 15, validate } = {}) {
  if (!options.length) throw new Error(`No options available for ${message}`);
  return inquirerCheckbox({
    message,
    choices: promptChoices(options),
    pageSize: Math.min(Math.max(pageSize, 7), 25),
    loop: false,
    required: false,
    validate,
  });
}

export async function searchableCheckboxMenu(
  message,
  options,
  { pageSize = 15, validate, searchPlaceholder = "Filter by name or email" } = {}
) {
  if (!options.length) throw new Error(`No options available for ${message}`);
  const selected = new Set(options.filter((entry) => entry.checked).map((entry) => entry.value));
  while (true) {
    const query = String(await inquirerInput({
      message: `${searchPlaceholder} (leave empty to show all)`,
    }) || "").trim().toLocaleLowerCase();
    const visible = options.filter((entry) => !query ||
      [entry.label, entry.description, entry.value].some((value) =>
        String(value || "").toLocaleLowerCase().includes(query)
      )
    );
    if (!visible.length) {
      console.log(color.warning("No matching entries. Try another filter."));
      continue;
    }
    const visibleValues = new Set(visible.map((entry) => entry.value));
    const picked = await inquirerCheckbox({
      message,
      choices: promptChoices(visible.map((entry) => ({
        ...entry,
        checked: selected.has(entry.value),
      }))),
      pageSize: Math.min(Math.max(pageSize, 7), 25),
      loop: false,
      required: false,
    });
    for (const value of visibleValues) selected.delete(value);
    for (const value of picked) selected.add(value);
    const action = await inquirerSelect({
      message: `${selected.size} selected`,
      choices: [
        { name: "Confirm selection", value: "done" },
        { name: "Search and add/remove more", value: "search" },
      ],
      loop: false,
    });
    if (action === "search") continue;
    const values = [...selected];
    const validation = validate?.(values);
    if (validation && validation !== true) {
      console.log(color.warning(validation));
      continue;
    }
    return values;
  }
}

export function confirm(message, defaultValue = false) {
  return inquirerConfirm({ message, default: defaultValue });
}

export function input(message, defaultValue = "", { validate } = {}) {
  return inquirerInput({ message, default: defaultValue || undefined, validate });
}

export function password(message, { validate } = {}) {
  return inquirerPassword({ message, mask: "*", validate });
}

export async function pause(message = "Press Enter to continue") {
  await inquirerInput({ message });
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function clearLiveLine() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\r\u001b[2K");
}

export async function withSpinner(label, operation) {
  if (!process.stdout.isTTY) {
    console.log(color.accent(`… ${label}`));
    return operation();
  }

  let frame = 0;
  const render = () => {
    clearLiveLine();
    process.stdout.write(color.accent(`${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${label}`));
  };
  render();
  const timer = setInterval(render, 120);
  timer.unref?.();
  try {
    const value = await operation();
    clearInterval(timer);
    clearLiveLine();
    console.log(color.success(`✓ ${label}`));
    return value;
  } catch (error) {
    clearInterval(timer);
    clearLiveLine();
    console.log(color.danger(`✗ ${label}`));
    throw error;
  }
}

export function printCheck(label, result, detail = "") {
  const status = result === "ok"
    ? color.success("OK")
    : result === "warning"
      ? color.warning("WARNING")
      : color.danger("MISSING");
  console.log(`  ${label.padEnd(26)} ${status}${detail ? `  ${color.muted(detail)}` : ""}`);
}

export function printProgress(status, label, detail = "") {
  const symbol = status === "success"
    ? color.success("✓")
    : status === "failure"
      ? color.danger("✗")
      : status === "warning"
        ? color.warning("!")
        : color.accent("◐");
  console.log(`${symbol} ${label}${detail ? ` ${color.muted(detail)}` : ""}`);
}

export function backOption(label = "Back") {
  return { label: `← ${label}`, value: "back" };
}
