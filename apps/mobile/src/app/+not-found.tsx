import { Redirect } from "expo-router";

export default function NotFound() {
  // All unmatched routes (including deep links like linkshell://input)
  // redirect to the home tab. The deep link is handled by Linking listener
  // in the root _layout.tsx.
  return <Redirect href="/" />;
}
