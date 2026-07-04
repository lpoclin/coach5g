package k8s

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/lpoclin/coach5g/api-server/internal/k8s/coreprofile"
)

// PodToNodeExported wraps the unexported podToNode for handlers.
func PodToNodeExported(pod *corev1.Pod, profile coreprofile.CoreProfile) *TopologyNode {
	return podToNode(pod, profile)
}

func listOpts() metav1.ListOptions {
	return metav1.ListOptions{}
}

func getOpts() metav1.GetOptions {
	return metav1.GetOptions{}
}
