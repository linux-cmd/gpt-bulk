const { EditorView } = require("prosemirror-view");
const { EditorState } = require("prosemirror-state");
const { schema } = require("prosemirror-schema-basic");

window.mountProseMirror = (editor, onChange) => {
  const emptyState = () => EditorState.create({schema});
  const view = new EditorView({mount: editor}, {
    state: emptyState(),
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      onChange();
    }
  });
  return {
    text() {
      const doc = view.state.doc;
      return doc.textBetween(0, doc.content.size, "\n\n", node =>
        node.type.name === "hard_break" ? "\n" : "");
    },
    clear() { view.updateState(emptyState()); }
  };
};
