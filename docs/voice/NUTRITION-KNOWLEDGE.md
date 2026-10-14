# Nutrition knowledge in continuous voice

The continuous audio session now exposes `retrieve_nutrition_knowledge`. It retrieves up to three versioned, source-linked passages from a curated local corpus covering the existing energy budget, macro policy, activity quality, portions, confirmation, and next-food workflow.

This is a small lexical retrieval implementation, not an embeddings service, a clinical nutrition library, or a complete ingestion of historical chats. Its corpus contains reviewed implementation summaries of repository rules. Macro policy passages explicitly retain `PENDING_EXTERNAL_REVIEW`; implementation availability does not imply clinical approval.

The voice instructions require retrieval for explanatory nutrition questions. Retrieved material is data, not instructions. Personal values and food-specific nutrients still come from the existing state, catalog and deterministic calculation tools. Retrieval cannot log food or replace independent spoken confirmation. Unsupported questions return no passages instead of fabricated citations.

Topic redirection currently uses conversation instructions. This is not a guaranteed domain firewall: direct audio may generate a response before a separate transcript-based gate could inspect it. A strict nutrition-only release needs measured voice evaluations and a response-control design before claiming enforcement. The architecture's planned pre-model gate, numeric speech validator and vector retrieval service remain separate work.

The current preview still uses synthetic nutrition/activity fixtures. Actual phone audio, grounded conversational behavior, interruption timing and off-topic resilience must be tested on-device. No new live paid API call was needed for the automated implementation checks.
