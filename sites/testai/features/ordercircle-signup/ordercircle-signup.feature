@ordercircle-signup
Feature: Ordercircle Signup

  Scenario: Create a new product with inventory tracking
    Given I am logged in as admin
    When I navigate to the Products page
    And I click the "Add New Product" button
    And I enter the product name "abc"
    And I enter the product SKU "123"
    And I enable the inventory tracking feature
    And I set the inventory level to "023"
    Then the product form should be displayed
