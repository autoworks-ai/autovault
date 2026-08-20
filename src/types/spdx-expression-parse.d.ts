declare module "spdx-expression-parse" {
  type SpdxExpression = {
    license: string;
    exception?: string;
    left?: SpdxExpression;
    right?: SpdxExpression;
    conjunction?: "and" | "or";
  };

  function parseSpdxExpression(expression: string): SpdxExpression;

  export default parseSpdxExpression;
}
