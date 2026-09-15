require "yaml"

workflow_dir = File.expand_path("../.github/workflows", __dir__)
publish_files = %w[docker-publish.yml docker.yml docker-dev.yml]
acr_login = {
  "registry" => "${{ vars.ACR_REGISTRY }}",
  "username" => "${{ vars.ACR_USERNAME }}",
  "password" => "${{ secrets.ACR_REDACTED_CREDENTIAL }}",
}
required_references = [
  "${{ vars.ACR_IMAGE }}",
  "${{ vars.ACR_REGISTRY }}",
  "${{ vars.ACR_USERNAME }}",
  "${{ secrets.ACR_REDACTED_CREDENTIAL }}",
]

publish_files.each do |filename|
  path = File.join(workflow_dir, filename)
  raw = File.read(path)
  workflow = YAML.load_file(path)

  required_references.each do |reference|
    abort "FAIL #{filename}: missing #{reference}" unless raw.include?(reference)
  end
  abort "FAIL #{filename}: must not use pull_request_target" if raw.include?("pull_request_target")
  abort "FAIL #{filename}: registry failures must not be ignored" if raw.include?("continue-on-error")
  unless workflow.fetch("env").fetch("ACR_IMAGE") == "${{ vars.ACR_IMAGE }}"
    abort "FAIL #{filename}: ACR_IMAGE must come from the repository variable"
  end

  steps = workflow.fetch("jobs").values.flat_map { |job| job.fetch("steps", []) }
  logins = steps.select { |step| step["uses"] == "docker/login-action@v3" }
  acr_logins = logins.select { |step| step["name"] == "Log in to Alibaba Cloud ACR" }
  expected_acr_logins = filename == "docker-publish.yml" ? 1 : 2
  unless acr_logins.length == expected_acr_logins && acr_logins.all? { |step| step.fetch("with") == acr_login }
    abort "FAIL #{filename}: every publishing job must log in to ACR with repository settings"
  end

  validation = steps.find { |step| step["name"] == "Validate registry configuration" }
  abort "FAIL #{filename}: missing registry configuration validation" unless validation
  %w[ACR_IMAGE ACR_REGISTRY ACR_USERNAME ACR_PASSWORD].each do |name|
    abort "FAIL #{filename}: validation does not reject missing #{name}" unless validation.fetch("run").include?(name)
  end

  builds = steps.select { |step| step["uses"] == "docker/build-push-action@v6" }
  abort "FAIL #{filename}: expected one build invocation" unless builds.length == 1

  if filename == "docker-publish.yml"
    build = builds.first.fetch("with")
    unless build.fetch("platforms") == "linux/amd64,linux/arm64" && build.fetch("push") == true
      abort "FAIL #{filename}: continuous publish must push one amd64/arm64 build"
    end
    tags = steps.find { |step| step["name"] == "Set image tags" }.fetch("run")
    %w[$IMAGE_NAME:latest $IMAGE_NAME:sha- $ACR_IMAGE:latest $ACR_IMAGE:sha-].each do |tag|
      abort "FAIL #{filename}: missing tag #{tag}" unless tags.include?(tag)
    end
  else
    output = builds.first.fetch("with").fetch("outputs")
    expected_output = 'type=image,"name=${{ env.IMAGE_NAME }},${{ env.ACR_IMAGE }}",push-by-digest=true,name-canonical=true,push=true'
    abort "FAIL #{filename}: architecture build must export one digest to both registries" unless output == expected_output
  end

  puts "PASS #{filename}: dual-registry publish contract"
end

security = YAML.load_file(File.join(workflow_dir, "security.yml"))
scout = security.fetch("jobs").fetch("scout").fetch("steps").find do |step|
  step["uses"] == "docker/scout-action@v1"
end
unless scout && scout.fetch("with").values_at("command", "image", "only-severities", "only-fixed", "exit-code") ==
    ["cves", "local://trek:scan", "critical,high", true, true]
  abort "FAIL security.yml: Docker Scout blocking policy changed"
end
puts "PASS security.yml: Docker Scout blocking policy"
