// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUi } from "./store";
import { Toasts } from "./components/toasts";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useUi.setState({ toast: null, modal: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("announces success, expires after six seconds and never persists overlays", () => {
  render(<Toasts />);
  act(() => useUi.getState().showToast("Saved"));
  expect(screen.getByRole("status").textContent).toContain("Saved");
  act(() => useUi.getState().setModal("auto-fixes"));
  const saved = JSON.parse(localStorage.getItem("token-furnace-provider-pins")!).state;
  expect(saved.toast).toBeUndefined();
  expect(saved.modal).toBeUndefined();
  act(() => vi.advanceTimersByTime(5999));
  expect(screen.getByText("Saved")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Saved")).toBeNull();
});

it("replaces previous feedback with a fresh timer and supports dismissal", () => {
  render(<Toasts />);
  act(() => useUi.getState().showToast("First"));
  act(() => vi.advanceTimersByTime(5000));
  act(() => useUi.getState().showToast("Second"));
  expect(screen.queryByText("First")).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Second")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByText("Second")).toBeNull();
});

it("pauses expiry on hover and keyboard focus", () => {
  render(<Toasts />);
  act(() => useUi.getState().showToast("Saved"));
  const message = screen.getByText("Saved").parentElement!;
  fireEvent.mouseEnter(message);
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText("Saved")).toBeTruthy();
  fireEvent.mouseLeave(message);
  fireEvent.focus(screen.getByRole("button", { name: "Dismiss notification" }));
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText("Saved")).toBeTruthy();
  fireEvent.blur(screen.getByRole("button", { name: "Dismiss notification" }));
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByText("Saved")).toBeNull();
});

it("starts a new timer after dismissing a hovered toast", () => {
  render(<Toasts />);
  act(() => useUi.getState().showToast("First"));
  fireEvent.mouseEnter(screen.getByText("First").parentElement!);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  act(() => useUi.getState().showToast("Second"));
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByText("Second")).toBeNull();
});

it("keeps errors visible until dismissed", () => {
  render(<Toasts />);
  act(() => useUi.getState().showToast("Could not save", "error"));
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByText("Could not save")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByText("Could not save")).toBeNull();
});
