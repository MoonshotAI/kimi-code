import json
import os
import unittest

class TestPluginJson(unittest.TestCase):
    def setUp(self):
        # Allow running from root or other locations
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.plugin_path = os.path.join(base_dir, 'frontend-design', '.kimi-plugin', 'plugin.json')

        # Define the expected schema
        self.schema = {
            "type": "object",
            "required": ["name", "version", "description", "author"],
            "properties": {
                "name": {"type": "string"},
                "version": {"type": "string"},
                "description": {"type": "string"},
                "author": {
                    "type": "object",
                    "required": ["name", "email"],
                    "properties": {
                        "name": {"type": "string"},
                        "email": {"type": "string"}
                    }
                }
            }
        }

    def validate_schema(self, instance, schema, path="root"):
        if schema.get("type") == "object":
            self.assertIsInstance(instance, dict, f"Expected object at {path}")

            # Check required fields
            for req in schema.get("required", []):
                self.assertIn(req, instance, f"Missing required property '{req}' at {path}")

            # Check properties
            for prop, prop_schema in schema.get("properties", {}).items():
                if prop in instance:
                    self.validate_schema(instance[prop], prop_schema, f"{path}.{prop}")

        elif schema.get("type") == "string":
            self.assertIsInstance(instance, str, f"Expected string at {path}")

        elif schema.get("type") == "number":
            self.assertIsInstance(instance, (int, float), f"Expected number at {path}")

        elif schema.get("type") == "boolean":
            self.assertIsInstance(instance, bool, f"Expected boolean at {path}")

        elif schema.get("type") == "array":
            self.assertIsInstance(instance, list, f"Expected array at {path}")
            if "items" in schema:
                for i, item in enumerate(instance):
                    self.validate_schema(item, schema["items"], f"{path}[{i}]")

    def test_json_is_valid_and_matches_schema(self):
        self.assertTrue(os.path.exists(self.plugin_path), f"File not found: {self.plugin_path}")

        with open(self.plugin_path, 'r') as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError as e:
                self.fail(f"Invalid JSON: {e}")

        self.validate_schema(data, self.schema)

if __name__ == '__main__':
    unittest.main()
