# Template — copy to `features/<feature-slug>/<name>.feature` and fill in.
# Then add a sibling `<name>.steps.ts` that maps each step phrase to code
# (re-use existing POMs from pages/<feature>/<Name>Page.ts).

Feature: <One-line capability — what the user can do>
  As a <user role>, I want to <do something> so that <benefit>.

  Background:
    # Pre-conditions every scenario shares. Use Given to set up state.
    Given I am on the <starting screen>

  # ---------------------------------------------------------------------
  # Positive cases — happy path proving the AC
  # ---------------------------------------------------------------------

  Scenario: AC1-POS-01 — <short positive case title>
    When I <perform the action>
    Then I should see <expected positive outcome>
    And <additional assertion>

  # ---------------------------------------------------------------------
  # Negative cases — required fields, format, server rejection
  # ---------------------------------------------------------------------

  Scenario: AC1-NEG-01 — <short negative case title>
    When I <perform the action with invalid input>
    Then I should remain on <screen>
    And <error / no-redirect assertion>

  # Use Scenario Outline for parameterised cases (e.g. trying many bad inputs):
  #
  # Scenario Outline: AC1-NEG — invalid <field> rejected
  #   When I submit with <field> = "<value>"
  #   Then I should see "<expected error>"
  #
  #   Examples:
  #     | field | value         | expected error            |
  #     | email | not-an-email  | Please enter a valid email |
  #     | email | @x.co         | Please enter a valid email |
