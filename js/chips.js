// Member-name input that turns each name into a removable chip.

import { h } from "./dom.js";
import { LIMITS, checkMemberName } from "./validate.js";

/**
 * @param {HTMLElement} root   empty container; its id + "-input" becomes the text input's id
 * @param {{ onError: (message: string) => void }} options
 */
export function createChipInput(root, { onError }) {
  let values = [];

  const list = h("ul", { class: "chips__list", "aria-label": "Members added" });
  const input = h("input", {
    id: `${root.id}-input`,
    class: "chips__input",
    type: "text",
    autocomplete: "off",
    placeholder: "Add a name",
    enterkeyhint: "enter",
  });
  const addButton = h("button", { type: "button", class: "btn btn--secondary", text: "Add" });
  root.replaceChildren(list, h("div", { class: "chips__entry" }, input, addButton));

  function render() {
    list.replaceChildren(
      ...values.map((name, index) =>
        h(
          "li",
          { class: "chip" },
          h("span", { class: "chip__text", text: name }),
          h("button", {
            type: "button",
            class: "chip__remove",
            "aria-label": `Remove ${name}`,
            text: "×",
            onclick: () => {
              values.splice(index, 1);
              render();
              input.focus();
            },
          }),
        ),
      ),
    );
    input.disabled = values.length >= LIMITS.membersMax;
    addButton.disabled = input.disabled;
    input.placeholder = input.disabled ? "Member limit reached" : "Add a name";
  }

  /** Adds every comma- or newline-separated name in `text`. Returns false if any was rejected. */
  function addFrom(text) {
    const names = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const raw of names) {
      const checked = checkMemberName(raw);
      if ("error" in checked) {
        onError(checked.error);
        return false;
      }
      if (values.some((v) => v.toLowerCase() === checked.value.toLowerCase())) continue;
      if (values.length >= LIMITS.membersMax) {
        onError(`A group can list at most ${LIMITS.membersMax} members.`);
        return false;
      }
      values.push(checked.value);
    }
    render();
    return true;
  }

  function commitInput() {
    if (!input.value.trim()) return true;
    const ok = addFrom(input.value);
    if (ok) input.value = "";
    return ok;
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitInput();
    } else if (event.key === "Backspace" && input.value === "" && values.length > 0) {
      values.pop();
      render();
    }
  });
  input.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (/[,\n]/.test(text)) {
      event.preventDefault();
      addFrom(input.value + text);
      input.value = "";
    }
  });
  addButton.addEventListener("click", () => {
    commitInput();
    input.focus();
  });

  render();

  return {
    /** Picks up a name that was typed but not yet confirmed with Enter. */
    commitPending: commitInput,
    getValues: () => [...values],
    setValues(next) {
      values = [...next];
      input.value = "";
      render();
    },
  };
}
