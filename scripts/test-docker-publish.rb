require "yaml"

workflow_dir = File.expand_path("../.github/workflows", __dir__)
publish_files = %w[docker-publish.yml docker.yml docker-dev.yml]
docker_hub_login = {
  "username" => "${{ secrets.DOCKERHUB_USERNAME }}",
  "password" => "${{ secrets.DOCKERHUB_TOKEN }}",
}

publish_files.each do |filename|
  path = File.join(workflow_dir, filename)
  raw = File.read(path)
  workflow = YAML.load_file(path)

  abort "FAIL #{filename}: must not use pull_request_target" if raw.include?("pull_request_target")
  abort "FAIL #{filename}: registry failures must not be ignored" if raw.include?("continue-on-error")
  unless workflow.fetch("env") == { "IMAGE_NAME" => "huahaizhi/trek-chinese" }
    abort "FAIL #{filename}: IMAGE_NAME must be the only registry target"
  end

  steps = workflow.fetch("jobs").values.flat_map { |job| job.fetch("steps", []) }
  logins = steps.select { |step| step["uses"] == "docker/login-action@v3" }
  unless logins.length == 2 && logins.all? { |step| step.fetch("with") == docker_hub_login }
    abort "FAIL #{filename}: publishing jobs must authenticate only to Docker Hub"
  end

  validation = steps.find { |step| step["name"] == "Validate Docker Hub credentials" }
  abort "FAIL #{filename}: missing Docker Hub credential validation" unless validation
  %w[DOCKERHUB_USERNAME DOCKERHUB_TOKEN].each do |name|
    abort "FAIL #{filename}: validation does not reject missing #{name}" unless validation.fetch("run").include?(name)
  end

  builds = steps.select { |step| step["uses"] == "docker/build-push-action@v6" }
  abort "FAIL #{filename}: expected one build invocation" unless builds.length == 1
  build = builds.first.fetch("with")
  if build["provenance"] == false || build["sbom"] == false
    abort "FAIL #{filename}: provenance and SBOM attestations must not be disabled"
  end

  output = build.fetch("outputs")
  expected_output = "type=image,name=${{ env.IMAGE_NAME }},push-by-digest=true,name-canonical=true,push=true"
  abort "FAIL #{filename}: architecture build must export one Docker Hub digest" unless output == expected_output

  puts "PASS #{filename}: Docker Hub-only publish contract"
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
