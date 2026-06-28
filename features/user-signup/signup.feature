@signup
Feature: User Signup
  As a new visitor to Moontower, I want to fill in the signup form and register
  a new account so that I can access the platform.

  Background:
    Given I am on the Moontower signup page

  # ---------------------------------------------------------------------
  # POSITIVE — happy path (DESTRUCTIVE: creates a real tenant on prod)
  # Gated behind RUN_DESTRUCTIVE_SIGNUP=1 so default runs are safe.
  # ---------------------------------------------------------------------

  @destructive
  Scenario: AC1-POS-01 — successful 2-step signup creates a new tenant
    Given destructive signup runs are explicitly enabled
    When I fill step 1 with a unique restaurant and valid contact details
    And I click "Next"
    And I enter Password "TestPass!2025" and Confirm Password "TestPass!2025"
    And I check the Terms checkbox
    And I click "Create Account"
    Then the URL should leave /signup

  @destructive
  Scenario: AC2-POS-01 — after registration the post-signup screen confirms the new restaurant
    Given destructive signup runs are explicitly enabled
    When I fill step 1 with a unique restaurant and valid contact details
    And I click "Next"
    And I enter Password "TestPass!2025" and Confirm Password "TestPass!2025"
    And I check the Terms checkbox
    And I click "Create Account"
    Then the URL should match "/select-location$"
    And I should see the heading "Select Your Location"
    And I should see a paragraph beginning with "Restaurant:" referencing the new restaurant

  # ---------------------------------------------------------------------
  # Step 1 validation — required fields & format
  # ---------------------------------------------------------------------

  Scenario: NEG-01 — Restaurant Name empty: Next does not advance
    When I fill step 1 leaving the "Restaurant Name" field empty
    And I click "Next"
    Then the step-1 form should still be visible
    And the step-2 "Set Password" form should not appear

  Scenario: NEG-03 — Business Email empty: Next does not advance
    When I fill step 1 leaving the "Business Email" field empty
    And I click "Next"
    Then the step-1 form should still be visible
    And the step-2 "Set Password" form should not appear

  Scenario: NEG-04 — Invalid email format is rejected by HTML5 validity
    When I fill step 1 with Business Email "arslan-yopmail.com"
    And I click "Next"
    Then the Business Email field should report a typeMismatch validity error
    And the step-1 form should still be visible

  Scenario: NEG-07 — Subdomain auto-derives from Restaurant Name and is read-only
    Then the Subdomain field should have the readonly attribute
    When I type "My Eatery 42" into the Restaurant Name field
    Then the Subdomain value should be lowercase kebab-case
    And the Subdomain should contain "my"
    And the Subdomain should contain "eatery"

  # ---------------------------------------------------------------------
  # Step 2 validation
  # ---------------------------------------------------------------------

  Scenario: NEG-10 — Create Account is disabled when Terms checkbox is unchecked
    When I reach step 2 with valid step-1 data
    And I enter matching passwords on step 2 without checking Terms
    Then the Create Account button should be disabled
    And the Terms checkbox should be unchecked

  Scenario: NEG-08 — Create Account does not submit when passwords mismatch
    When I reach step 2 with valid step-1 data
    And I enter Password "TestPass!2025" and Confirm Password "DifferentTestPass!2025"
    And I check the Terms checkbox
    And I click "Create Account"
    Then I should remain on the signup page
    And the step-2 "Set Password" form should still be visible

  # ---------------------------------------------------------------------
  # UI behaviour
  # ---------------------------------------------------------------------

  Scenario: UI-01 — Subdomain, Location Name, and Address fields are read-only
    Then the field "subDomain" should have the readonly attribute
    And the field "locationName" should have the readonly attribute
    And the field "locationAddress" should have the readonly attribute

  Scenario: UI-03 — Show/Hide password toggle works on step 2
    When I reach step 2 with valid step-1 data
    And I fill the Password field with "Secret!2025"
    Then the Password field input type is "password"
    When I click the show-password toggle next to Password
    Then the Password field input type is "text"
    When I click the show-password toggle next to Password
    Then the Password field input type is "password"

  # ---------------------------------------------------------------------
  # Navigation
  # ---------------------------------------------------------------------

  Scenario: NAV-01 — "Sign in" link navigates to /login
    When I click the "Sign in" link
    Then the URL should match "/login$"

  Scenario: NAV-02 — "← Back" link navigates to the homepage
    When I click the "← Back" link
    Then the URL should match the homepage
